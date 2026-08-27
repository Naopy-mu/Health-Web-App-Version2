-- 実装仕様書 6.6節「ストレージ」・5.8節「食事画像解析」。
--
--   - 非公開バケット health-images と food-images-private の2つ。いずれも匿名不可。
--   - オブジェクトパスは <auth.uid()>/<random-uuid>.<検証済み拡張子> に固定し、
--     Storageオブジェクト（パス）とメタデータ行（owner_id）の双方で所有者を検査する。
--   - 公開URLは保存しない（アクセスは署名URL経由）。

-- ---------------------------------------------------------------------------
-- バケット定義。
--   - health-images       : 6.6節どおり 10MiB、JPEG/PNG/WebP/HEIC/HEIF。
--   - food-images-private : 5.8節どおり 6MB（6,000,000バイト）以下、JPEG/PNG/WebP のみ。
--                           HEIC/HEIF は非対応であることをDB側でも固定する。
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  (
    'health-images',
    'health-images',
    false,
    10485760,
    array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
  ),
  (
    'food-images-private',
    'food-images-private',
    false,
    6000000,
    array['image/jpeg', 'image/png', 'image/webp']
  )
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- パス規則の検査関数。先頭セグメントが所有者UUIDと一致し、ファイル名が
-- ランダムUUID + バケットごとに許可した拡張子であることだけを許可する。
-- ---------------------------------------------------------------------------
create or replace function public.storage_object_path_is_owned(
  object_name text,
  owner uuid,
  allowed_extensions text[]
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select owner is not null
    and object_name is not null
    and allowed_extensions is not null
    and pg_catalog.array_length(allowed_extensions, 1) > 0
    and object_name ~ (
      '^' || owner::text
        || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
        || '\.(' || pg_catalog.array_to_string(allowed_extensions, '|') || ')$'
    );
$$;

comment on function public.storage_object_path_is_owned(text, uuid, text[]) is
  '実装仕様書 6.6節: オブジェクトパスを <auth.uid()>/<random-uuid>.<検証済み拡張子> に固定する検査。拡張子はバケットごとに指定する（5.8節）。';

revoke all on function public.storage_object_path_is_owned(text, uuid, text[]) from public, anon, authenticated;
grant execute on function public.storage_object_path_is_owned(text, uuid, text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- Storageポリシー。anon 向けポリシーは作らないため匿名アクセスは既定拒否。
-- authenticated も自分のUUID配下の正規パスにしか到達できない。
--
-- storage.objects の RLS は Supabase が既定で有効にしており、テーブル所有者は
-- supabase_storage_admin であるため、migration から
-- `alter table storage.objects enable row level security` を実行すると
-- 42501（must be owner of table objects）で失敗する。ここでは有効化を試みず、
-- ポリシーの作成のみを行う。
--
-- 6.6節「Storageオブジェクトとメタデータ行の双方で所有者を検査する」に従い、
-- パス（name の先頭セグメント）と メタデータ行（owner_id）の両方が
-- auth.uid() と一致することを要求する。storage.objects.owner_id は text 型。
-- ---------------------------------------------------------------------------
do $$
declare
  bucket text;
  extensions text[];
begin
  foreach bucket in array array['health-images', 'food-images-private']
  loop
    -- 5.8節: 食事画像は JPEG/PNG/WebP のみ（HEIC/HEIF 非対応）。
    extensions := case bucket
      when 'food-images-private' then array['jpg', 'jpeg', 'png', 'webp']
      else array['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']
    end;

    execute pg_catalog.format('drop policy if exists %I on storage.objects', bucket || '_select_own');
    execute pg_catalog.format('drop policy if exists %I on storage.objects', bucket || '_insert_own');
    execute pg_catalog.format('drop policy if exists %I on storage.objects', bucket || '_update_own');
    execute pg_catalog.format('drop policy if exists %I on storage.objects', bucket || '_delete_own');

    execute pg_catalog.format(
      $policy$
        create policy %I on storage.objects
        for select to authenticated
        using (
          bucket_id = %L
          and owner_id = (select auth.uid())::text
          and public.storage_object_path_is_owned(name, (select auth.uid()), %L::text[])
          and public.is_active_user()
        )
      $policy$,
      bucket || '_select_own', bucket, extensions
    );

    execute pg_catalog.format(
      $policy$
        create policy %I on storage.objects
        for insert to authenticated
        with check (
          bucket_id = %L
          and owner_id = (select auth.uid())::text
          and public.storage_object_path_is_owned(name, (select auth.uid()), %L::text[])
          and public.is_active_user()
        )
      $policy$,
      bucket || '_insert_own', bucket, extensions
    );

    execute pg_catalog.format(
      $policy$
        create policy %I on storage.objects
        for update to authenticated
        using (
          bucket_id = %L
          and owner_id = (select auth.uid())::text
          and public.storage_object_path_is_owned(name, (select auth.uid()), %L::text[])
          and public.is_active_user()
        )
        with check (
          bucket_id = %L
          and owner_id = (select auth.uid())::text
          and public.storage_object_path_is_owned(name, (select auth.uid()), %L::text[])
          and public.is_active_user()
        )
      $policy$,
      bucket || '_update_own', bucket, extensions, bucket, extensions
    );

    execute pg_catalog.format(
      $policy$
        create policy %I on storage.objects
        for delete to authenticated
        using (
          bucket_id = %L
          and owner_id = (select auth.uid())::text
          and public.storage_object_path_is_owned(name, (select auth.uid()), %L::text[])
          and public.is_active_user()
        )
      $policy$,
      bucket || '_delete_own', bucket, extensions
    );
  end loop;
end;
$$;
