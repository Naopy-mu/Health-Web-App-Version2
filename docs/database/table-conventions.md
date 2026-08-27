# テーブル共通規約（実装仕様書 6章）

Phase 1「DBスキーマ基盤」で用意した共通ルールをまとめる。**後続フェーズで機能テーブル
（`body_measurements`、`workout_sessions`、`meal_recipes` など）を追加するときは、
本書のテンプレートをそのまま踏襲すること。**

対応する migration:

| ファイル                                                         | 内容                                                                                                     |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `supabase/migrations/20260827000100_owned_table_conventions.sql` | 版番号・冪等性の共通トリガーと取り付け関数（実装仕様書 6.4節）                                           |
| `supabase/migrations/20260827000200_identity_core.sql`           | `public.users` / `public.user_profiles` / `is_active_user()` / `on_auth_user_created`（6.1・6.2・6.5節） |
| `supabase/migrations/20260827000300_identity_rls.sql`            | ID・プロフィールの RLS（6.5節・9章）                                                                     |
| `supabase/migrations/20260827000400_storage_buckets.sql`         | 非公開バケットと Storage ポリシー（6.6節）                                                               |

migration のファイル名は `YYYYMMDDHHMMSS_<snake_case>.sql`。番号は既存の最大値より必ず大きくする。

---

## 1. 所有者スコープの可変公開テーブル（6.2節・6.4節）

### 1.1 列パターン

```sql
create table public.<table> (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references public.users (id) on delete cascade,

  -- ここに機能固有の列を書く（日時は timestamptz、日単位は date。実装仕様書 6.3節）

  client_mutation_id uuid,
  row_version        bigint not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- 子テーブルの複合外部キーの参照先になる候補キー
  constraint <table>_id_owner_id_key unique (id, owner_id)
);

-- 冪等性インデックスと共通トリガーを取り付ける
select public.apply_owned_mutable_table_conventions('public.<table>'::regclass);
```

`apply_owned_mutable_table_conventions()` は次を行う。

1. `id` / `owner_id` / `client_mutation_id` / `row_version` / `created_at` / `updated_at` が
   揃っているかを検査し、欠けていれば `42703` で失敗する。
2. `(id, owner_id)` の一意候補キーが無ければ `42830` で失敗する。
3. `(owner_id, client_mutation_id)` の **NULL 除外一意インデックス** を作る
   （`... where client_mutation_id is not null`）。
4. `BEFORE INSERT` / `BEFORE UPDATE` の共通トリガーを取り付ける。

> `audit_logs` のような追記専用テーブルは本パターンの対象外（実装仕様書 6.4節）。

### 1.2 共通トリガーの動作

| タイミング    | 関数                                      | 動作                                                                                                               |
| ------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| BEFORE INSERT | `public.tg_owned_mutable_before_insert()` | クライアント入力によらず `row_version = 1`、`created_at` / `updated_at` をサーバー時刻にする                       |
| BEFORE UPDATE | `public.tg_owned_mutable_before_update()` | `id` / `owner_id` / `created_at` の変更を `23514` で拒否し、`row_version` を +1、`updated_at` をサーバー時刻にする |

`row_version` はサーバーだけが進める。クライアントが送った `row_version` は
**比較にのみ使い、保存には使わない**。

### 1.3 よく使うインデックス（6.2節）

```sql
create index <table>_owner_recorded_at_idx on public.<table> (owner_id, recorded_at desc);
create index <table>_owner_expires_at_idx  on public.<table> (owner_id, expires_at);
```

時系列検索は `(owner_id, timestamp)`、期限検索は `(owner_id, expiry)` の複合インデックスを持たせる。

---

## 2. 複合外部キー `(parent_id, owner_id) -> (id, owner_id)`（6.2節）

親子参照を **単独ID** で張ると、他利用者の親へ子を接続できてしまう。所有者列を含めた
複合外部キーにすることで、DB レベルで所有者をまたぐ接続を不可能にする。

```sql
-- 親
create table public.workout_routines (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references public.users (id) on delete cascade,
  name               text not null,
  client_mutation_id uuid,
  row_version        bigint not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint workout_routines_id_owner_id_key unique (id, owner_id)
);

-- 子: owner_id を含めて親を参照する
create table public.workout_routine_items (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references public.users (id) on delete cascade,
  routine_id         uuid not null,
  position           integer not null,
  client_mutation_id uuid,
  row_version        bigint not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint workout_routine_items_id_owner_id_key unique (id, owner_id),
  constraint workout_routine_items_routine_fkey
    foreign key (routine_id, owner_id)
    references public.workout_routines (id, owner_id) on delete cascade
);

select public.apply_owned_mutable_table_conventions('public.workout_routines'::regclass);
select public.apply_owned_mutable_table_conventions('public.workout_routine_items'::regclass);
```

守るべき点。

- 子の `owner_id` は **子自身の列**であり、親と同じ値でなければ外部キーが成立しない。
- 親の `owner_id` は共通 UPDATE トリガーが不変にするため、親の所有者を後から
  すり替えて子を奪うこともできない。
- `on delete cascade` は所有者ごとに閉じる。他利用者の削除が自分の行へ波及しない。
- 参照先の `(id, owner_id)` 一意制約を **必ず先に**宣言する（無ければ外部キーを作れない）。

`public.user_profiles` が実データでのこのパターンの最小例になっている
（`foreign key (id, owner_id) references public.users (id, owner_id)`）。
テンプレートが後続フェーズでもそのまま動くことは
`tests/db/mutation-patterns.test.ts` の「機能テーブルのテンプレート検証」で確認している。

---

## 3. 楽観ロックと冪等性（6.4節）

### 3.1 更新（HTTP 409 の扱い）

更新は必ず「所有者」「期待する版番号」を WHERE 句に含める。

```sql
update public.<table>
   set <columns> = <values>,
       client_mutation_id = :client_mutation_id
 where id = :id
   and owner_id = auth.uid()
   and row_version = :expected_row_version
returning *;
```

- **1件返った**: 更新成功。応答には新しい `row_version` を含め、クライアントは次回それを送る。
- **0件返った**: 競合。**HTTP 409** として扱う。
  行が存在しない場合と版番号が古い場合を区別せず 409 にするのは、
  他利用者の行の存在有無を漏らさないため。

Route Handler 側の骨格（Phase 2 以降）:

```ts
const { data, error } = await supabase
  .from("<table>")
  .update(patch)
  .eq("id", id)
  .eq("owner_id", session.user.id)
  .eq("row_version", expectedRowVersion)
  .select()
  .maybeSingle();

if (error) throw error;
if (data === null) {
  return jsonError(409, "CONFLICT_ROW_VERSION");
}
```

> `owner_id` は**検証済みサーバーセッションから導出**する。リクエストボディの
> `owner_id` / `user_id` は受け取らない（実装仕様書 3.2節・9.2節）。

### 3.2 作成（オフライン同期の再送）

作成時はクライアントが生成した `client_mutation_id`（UUID）を必ず添える。
`(owner_id, client_mutation_id)` の NULL 除外一意インデックスにより、
オフラインキューの再送で二重登録されない。

```sql
insert into public.<table> (owner_id, client_mutation_id, ...)
values (auth.uid(), :client_mutation_id, ...)
on conflict (owner_id, client_mutation_id) where client_mutation_id is not null
do nothing
returning *;
```

`do nothing` で 0 件だった場合は、既に適用済みの行を
`where owner_id = auth.uid() and client_mutation_id = :client_mutation_id` で読み直し、
**同じ成功応答**を返す（再送はエラーにしない）。

一意性は所有者ごとに閉じているため、別利用者が同じ `client_mutation_id` を
使っても衝突しない。`client_mutation_id` が NULL の行は何度でも作れる。

---

## 4. RLS の書き方（6.5節・9章）

新しいテーブルには必ず次をセットで書く。

```sql
alter table public.<table> enable row level security;

-- Supabase は public スキーマの新規テーブルへ既定で全権限を与えるため、明示的に剥奪する
revoke all on table public.<table> from public;
revoke all on table public.<table> from anon;
revoke all on table public.<table> from authenticated;

grant select, insert, update, delete on table public.<table> to authenticated;

create policy <table>_select_own on public.<table>
for select to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user());

create policy <table>_insert_own on public.<table>
for insert to authenticated
with check (owner_id = (select auth.uid()) and public.is_active_user());

create policy <table>_update_own on public.<table>
for update to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user())
with check (owner_id = (select auth.uid()) and public.is_active_user());

create policy <table>_delete_own on public.<table>
for delete to authenticated
using (owner_id = (select auth.uid()) and public.is_active_user());
```

- **所有者条件に加えて必ず `public.is_active_user()` を要求する。**
  `suspended` / `health_data_erasure_pending` / `deletion_pending` の利用者を全操作から排除する。
- `anon` 向けのポリシーは作らない（匿名アクセスは既定拒否）。
- `(select auth.uid())` の形で書くと、行ごとではなく1回だけ評価される。
- 書き込み主体がサーバーに限られるテーブル（実装仕様書 6.5節の例外表）は、
  `authenticated` への `grant` 自体を絞る。列単位で絞る場合は
  `grant update (col_a, col_b) on ... to authenticated;` を使う
  （`public.users` の `locale` / `timezone` / `last_seen_at` がその例）。
- `service_role` はブラウザへ渡さない。ブラウザが名乗れるのは `anon` / `authenticated` だけで、
  どちらも `service_role` のメンバーではない。

---

## 5. Storage（6.6節）

- バケットは非公開の `health-images` と `food-images-private` の2つ。上限とMIMEはバケットごとに異なる。

  | バケット              | 上限                | 許可MIME                                                        | 根拠  |
  | --------------------- | ------------------- | --------------------------------------------------------------- | ----- |
  | `health-images`       | 10MiB（10,485,760） | `image/jpeg` `image/png` `image/webp` `image/heic` `image/heif` | 6.6節 |
  | `food-images-private` | 6MB（6,000,000）    | `image/jpeg` `image/png` `image/webp`（HEIC/HEIF 非対応）       | 5.8節 |

- オブジェクトパスは **`<auth.uid()>/<random-uuid>.<検証済み拡張子>`** に固定する。
  `public.storage_object_path_is_owned(name, auth.uid(), <許可拡張子>)` が形を検査する。
  許可拡張子はバケットごとに渡す（`food-images-private` は `heic` / `heif` を含めない）。
- **パスとメタデータ行の双方で所有者を検査する。** Storage ポリシーは
  `owner_id = (select auth.uid())::text`（メタデータ行）と上記のパス検査の両方、
  および `public.is_active_user()` を要求する。`storage.objects.owner_id` は
  **text 型**であり uuid ではない。
- `storage.objects` の RLS は **Supabase が既定で有効**にしている。テーブル所有者は
  `supabase_storage_admin` なので、migration から
  `alter table storage.objects enable row level security` を実行すると
  42501（`must be owner of table objects`）で失敗する。migration はポリシー作成のみを行う。
- 公開URLは保存しない。取得は署名URL経由。
- 実体の検査（シグネチャ・MIME・寸法・ハッシュ）とメタデータ除去はアップロードAPI側の責務
  （実装仕様書 9.2節）。DB側はパスと所有者の最終防衛線に徹する。

---

## 6. 検証の走らせ方

| 対象                                          | コマンド                             | 備考                                                      |
| --------------------------------------------- | ------------------------------------ | --------------------------------------------------------- |
| PGlite への新規 migration 適用・RLS・トリガー | `npm test`                           | Docker 不要。`tests/db/`                                  |
| pgTAP（RLS 分離）                             | `supabase start && supabase test db` | Docker と Supabase CLI が必要。`supabase/tests/database/` |
| migration の lint                             | `supabase db lint`                   | Docker が必要                                             |

`tests/db/supabase-shim.sql` は PGlite 上で Supabase 相当の前提（`anon` / `authenticated` /
`service_role` ロール、`auth.users`、`auth.uid()`、`storage.buckets` / `storage.objects`、
public スキーマの既定権限）を再現するテスト専用ファイルで、migration ではない。
Supabase 側の前提が変わったときはこのファイルを合わせて更新する。
