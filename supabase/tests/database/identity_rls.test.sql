-- pgTAP: users / user_profiles の RLS 分離（実装仕様書 6.5節 / 9章）。
--
-- 実行には Docker と Supabase CLI が必要:
--   supabase start && supabase test db
-- Docker 非導入環境では実行できないが、同等の検証を PGlite 側
-- （tests/db/identity-rls.test.ts）で常時実行している。

begin;

create extension if not exists pgtap with schema extensions;

select plan(12);

-- ---------------------------------------------------------------------------
-- スキーマ契約
-- ---------------------------------------------------------------------------
select has_table('public', 'users', 'public.users が存在する');
select has_table('public', 'user_profiles', 'public.user_profiles が存在する');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.users'::regclass),
  'public.users で RLS が有効'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.user_profiles'::regclass),
  'public.user_profiles で RLS が有効'
);

-- ---------------------------------------------------------------------------
-- テスト用の利用者を2名作る（on_auth_user_created が users / user_profiles を作る）
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'owner-a@example.test', '', now(), now(), now()),
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'owner-b@example.test', '', now(), now(), now());

select is(
  (select count(*)::int from public.users where id in (
     '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222')),
  2,
  'on_auth_user_created が public.users を作る'
);
select is(
  (select count(*)::int from public.user_profiles where id = owner_id and id in (
     '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222')),
  2,
  'on_auth_user_created が同一UUIDで public.user_profiles を作る'
);

-- ---------------------------------------------------------------------------
-- 利用者A として所有者分離を検証する
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select is(
  (select count(*)::int from public.users),
  1,
  '自分の users 行だけが見える'
);
select is(
  (select count(*)::int from public.users where id = '22222222-2222-2222-2222-222222222222'),
  0,
  '他利用者の users 行は見えない'
);
select is(
  (select count(*)::int from public.user_profiles where owner_id <> auth.uid()),
  0,
  'owner_id が異なる user_profiles は見えない'
);
select is(
  (with updated as (
     update public.user_profiles set display_name = 'taken over'
     where owner_id = '22222222-2222-2222-2222-222222222222'
     returning 1
   )
   select count(*)::int from updated),
  0,
  '他利用者の user_profiles は更新できない'
);
select throws_ok(
  $$ update public.users set status = 'suspended' where id = auth.uid() $$,
  '42501',
  null,
  'users.status は authenticated から更新できない'
);

reset role;

-- ---------------------------------------------------------------------------
-- 利用者状態（実装仕様書 6.5節）
-- ---------------------------------------------------------------------------
update public.users set status = 'suspended'
where id = '11111111-1111-1111-1111-111111111111';

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select is(
  (select count(*)::int from public.users) + (select count(*)::int from public.user_profiles),
  0,
  'status が active でない利用者は自分の行にも到達できない'
);

reset role;

select * from finish();

rollback;
