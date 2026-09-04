-- 実装仕様書 5.5節 / 6.4節。体調記録（本体 + 症状リンク）を
-- **1トランザクション**で保存する DB 関数。
--
-- ## 何を直す migration か
--
-- 当初の実装は、体調記録の親行を `insert` / `update` した**あとで**、別の
-- RPC 呼び出し（`replace_condition_entry_symptoms`）で症状リンクを全置換していた。
-- 呼び出しが2回に分かれるため、症状置換だけが失敗すると
--
--   - 親行だけが確定した中途半端な状態が残る（症状は古いまま／消えたまま）
--   - `wellness_mutation_log` には「適用済み」として親のスナップショットが載る
--
-- という状態になる。冪等キーを付けて再送すればログから当時の応答が返るだけで、
-- 症状は貼り直されない。冪等キーを**付けずに**再送すると、新規作成では
-- 一意制約（owner_id, recorded_at）に当たって 409 になり、利用者は自力で
-- 復帰できない。
--
-- ## 直し方
--
-- 親行の作成／更新と症状の全置換を本関数の中へ入れ、1つの文（RPC 呼び出し）に
-- まとめる。関数本体は単一のトランザクションで実行されるため、症状置換が失敗
-- すれば親行の変更も、`wellness_mutation_log` への追記も、まとめて巻き戻る。
-- 「親だけ確定」は原理的に起きない。
--
-- あわせて、API 側は体調記録の作成・更新で `clientMutationId` を**必須**にする
-- （`src/features/wellness/schema.ts`）。キーがあれば、どこで失敗しても同じキーで
-- 安全に再送でき、成功していれば `idempotent_replay`、失敗していれば
-- 未適用としてやり直しになる。本関数もキー無しの呼び出しを拒否して、
-- API を経由しない直接呼び出しでも同じ前提が崩れないようにする。
--
-- ## 権限
--
-- SECURITY INVOKER。RLS がそのまま効くので、他人の体調記録・症状種別へは
-- 触れられない（症状の全置換は既存の `replace_condition_entry_symptoms` を
-- そのまま呼ぶ。所有者検査・43件上限の判定を1か所に保つ）。

create or replace function public.save_condition_entry(
  p_entry jsonb,
  p_client_mutation_id uuid,
  p_symptoms jsonb default null,
  p_id uuid default null,
  p_expected_row_version bigint default null
)
returns setof public.condition_entries
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor  uuid := (select auth.uid());
  fields public.condition_entries;
  saved  public.condition_entries;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  -- 安全な再試行の前提。キーが無いと、失敗が「未適用」なのか
  -- 「適用済みだが応答を受け取れなかった」のかを後から区別できない。
  if p_client_mutation_id is null then
    raise exception 'client_mutation_id is required to save a condition entry'
      using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(p_entry) is distinct from 'object' then
    raise exception 'entry must be a json object' using errcode = '22023';
  end if;

  -- 更新（id 指定）では楽観ロックを必ず通す（実装仕様書 6.4節）。
  if p_id is not null and p_expected_row_version is null then
    raise exception 'expected row version is required when updating by id'
      using errcode = '22023';
  end if;

  -- 列の型付けは jsonb_populate_record に任せる（未知のキーは無視される）。
  -- 実際に書くのは下の INSERT / UPDATE が明示した列だけなので、
  -- owner_id / id / row_version を混ぜ込まれても効かない（実装仕様書 3.2節）。
  fields := pg_catalog.jsonb_populate_record(null::public.condition_entries, p_entry);

  if p_id is null then
    insert into public.condition_entries (
      owner_id, recorded_at, timezone,
      overall_score, fatigue_score, energy_score, stress_score, pain_score, mood_score,
      body_temperature_c, free_text_symptoms, note, client_mutation_id
    )
    values (
      actor, fields.recorded_at, coalesce(fields.timezone, 'Asia/Tokyo'),
      fields.overall_score, fields.fatigue_score, fields.energy_score,
      fields.stress_score, fields.pain_score, fields.mood_score,
      fields.body_temperature_c, coalesce(fields.free_text_symptoms, '{}'::text[]),
      fields.note, p_client_mutation_id
    )
    returning * into saved;
  else
    update public.condition_entries as e
    set recorded_at        = fields.recorded_at,
        timezone           = coalesce(fields.timezone, 'Asia/Tokyo'),
        overall_score      = fields.overall_score,
        fatigue_score      = fields.fatigue_score,
        energy_score       = fields.energy_score,
        stress_score       = fields.stress_score,
        pain_score         = fields.pain_score,
        mood_score         = fields.mood_score,
        body_temperature_c = fields.body_temperature_c,
        free_text_symptoms = coalesce(fields.free_text_symptoms, '{}'::text[]),
        note               = fields.note,
        client_mutation_id = p_client_mutation_id
    where e.id = p_id
      and e.owner_id = actor
      and e.row_version = p_expected_row_version
    returning e.* into saved;

    -- 0件（行が無い／版番号が古い）。実装仕様書 6.4節に従い、両者を区別せず
    -- 「1件も返さない」で呼び出し側へ伝える（呼び出し側が 409 にする）。
    if saved.id is null then
      return;
    end if;
  end if;

  -- `p_symptoms` が null なら既存のリンクをそのまま残す（docs/api/wellness.md 6.3節）。
  -- 空配列なら全解除。どちらも本関数のトランザクションの内側で確定する。
  if p_symptoms is not null then
    perform public.replace_condition_entry_symptoms(saved.id, p_symptoms);
  end if;

  return next saved;
end;
$$;

comment on function public.save_condition_entry(jsonb, uuid, jsonb, uuid, bigint) is
  '実装仕様書 5.5節・6.4節: 体調記録の本体と症状リンクの全置換を1トランザクションで行う。client_mutation_id は必須。0件返却は版番号不一致または対象なし（409）。';

revoke all on function public.save_condition_entry(jsonb, uuid, jsonb, uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.save_condition_entry(jsonb, uuid, jsonb, uuid, bigint)
  to authenticated;
