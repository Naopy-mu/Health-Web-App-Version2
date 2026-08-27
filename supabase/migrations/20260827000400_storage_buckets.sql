-- 実装仕様書 6.6節「ストレージ」。
--
--   - 非公開バケット health-images と food-images-private の2つ。いずれも匿名不可。
--   - オブジェクトパスは <auth.uid()>/<random-uuid>.<検証済み拡張子> に固定する。
--   - 公開URLは保存しない（アクセスは署名URL経由）。

-- ---------------------------------------------------------------------------
-- バケット定義。最大10MiB、JPEG/PNG/WebP/HEIC/HEIF のみ。
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
    10485760,
    array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
  )
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- パス規則の検査関数。先頭セグメントが所有者UUIDと一致し、ファイル名が
-- ランダムUUID + 検証済み拡張子であることだけを許可する。
-- ---------------------------------------------------------------------------
create or replace function public.storage_object_path_is_owned(object_name text, owner uuid)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select owner is not null
    and object_name is not null
    and object_name ~ (
      '^' || owner::text
        || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
        || '\.(jpg|jpeg|png|webp|heic|heif)$'
    );
$$;

comment on function public.storage_object_path_is_owned(text, uuid) is
  '実装仕様書 6.6節: オブジェクトパスを <auth.uid()>/<random-uuid>.<検証済み拡張子> に固定する検査。';

revoke all on function public.storage_object_path_is_owned(text, uuid) from public, anon, authenticated;
grant execute on function public.storage_object_path_is_owned(text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Storageポリシー。anon 向けポリシーは作らないため匿名アクセスは既定拒否。
-- authenticated も自分のUUID配下の正規パスにしか到達できない。
-- ---------------------------------------------------------------------------
alter table storage.objects enable row level security;

do $$
declare
  bucket text;
begin
  foreach bucket in array array['health-images', 'food-images-private']
  loop
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
          and public.storage_object_path_is_owned(name, (select auth.uid()))
          and public.is_active_user()
        )
      $policy$,
      bucket || '_select_own', bucket
    );

    execute pg_catalog.format(
      $policy$
        create policy %I on storage.objects
        for insert to authenticated
        with check (
          bucket_id = %L
          and public.storage_object_path_is_owned(name, (select auth.uid()))
          and public.is_active_user()
        )
      $policy$,
      bucket || '_insert_own', bucket
    );

    execute pg_catalog.format(
      $policy$
        create policy %I on storage.objects
        for update to authenticated
        using (
          bucket_id = %L
          and public.storage_object_path_is_owned(name, (select auth.uid()))
          and public.is_active_user()
        )
        with check (
          bucket_id = %L
          and public.storage_object_path_is_owned(name, (select auth.uid()))
          and public.is_active_user()
        )
      $policy$,
      bucket || '_update_own', bucket, bucket
    );

    execute pg_catalog.format(
      $policy$
        create policy %I on storage.objects
        for delete to authenticated
        using (
          bucket_id = %L
          and public.storage_object_path_is_owned(name, (select auth.uid()))
          and public.is_active_user()
        )
      $policy$,
      bucket || '_delete_own', bucket
    );
  end loop;
end;
$$;
