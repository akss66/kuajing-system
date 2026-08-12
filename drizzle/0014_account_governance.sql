do $$
declare
  duplicate_customer_ids text;
  orphan_user_rows text;
  unsupported_roles text;
begin
  select string_agg(customer_id::text, ', ' order by customer_id::text)
  into duplicate_customer_ids
  from (
    select customer_id
    from auth_users
    where customer_id is not null
    group by customer_id
    having count(*) > 1
    order by customer_id
    limit 5
  ) duplicates;

  if duplicate_customer_ids is not null then
    raise exception 'Duplicate auth_users.customer_id values block account governance migration'
      using detail = 'customer_id(s): ' || duplicate_customer_ids,
        hint = 'Repair duplicate customer logins before applying drizzle/0014_account_governance.sql.';
  end if;

  select string_agg(format('%s=%s', email, role), ', ' order by email)
  into unsupported_roles
  from (
    select email, role
    from auth_users
    where role is not null
      and role not in ('admin', 'super_admin', 'user')
    order by email
    limit 5
  ) invalid_roles;

  if unsupported_roles is not null then
    raise exception 'Unsupported auth_users.role values block account governance migration'
      using detail = unsupported_roles,
        hint = 'Normalize legacy auth_users.role values before applying drizzle/0014_account_governance.sql.';
  end if;

  select string_agg(email, ', ' order by email)
  into orphan_user_rows
  from (
    select email
    from auth_users
    where coalesce(role, 'user') = 'user'
      and customer_id is null
    order by email
    limit 5
  ) orphan_users;

  if orphan_user_rows is not null then
    raise exception 'User role rows without customer_id block account governance migration'
      using detail = orphan_user_rows,
        hint = 'Assign each user auth row to a customer before applying drizzle/0014_account_governance.sql.';
  end if;
end $$;--> statement-breakpoint

update "auth_users"
set
  "role" = case
    when "customer_id" is not null then 'user'
    when coalesce("role", 'user') in ('admin', 'super_admin')
      and (
        "id" = '00000000-0000-4000-8000-00000000a001'
        or lower("email") = 'admin@tongzhouxing.local'
      ) then 'super_admin'
    when coalesce("role", 'user') in ('admin', 'super_admin') then 'admin'
    else coalesce("role", 'user')
  end,
  "banned" = coalesce("banned", false)
where
  "role" is distinct from case
    when "customer_id" is not null then 'user'
    when coalesce("role", 'user') in ('admin', 'super_admin')
      and (
        "id" = '00000000-0000-4000-8000-00000000a001'
        or lower("email") = 'admin@tongzhouxing.local'
      ) then 'super_admin'
    when coalesce("role", 'user') in ('admin', 'super_admin') then 'admin'
    else coalesce("role", 'user')
  end
  or "banned" is null;--> statement-breakpoint

alter table "auth_users"
  alter column "role" set default 'user',
  alter column "role" set not null,
  alter column "banned" set default false,
  alter column "banned" set not null;--> statement-breakpoint

alter table "auth_users"
  add constraint "auth_users_role_check"
  check ("role" in ('super_admin', 'admin', 'user'));--> statement-breakpoint

alter table "auth_users"
  add constraint "auth_users_customer_role_check"
  check (
    ("role" = 'user' and "customer_id" is not null)
    or ("role" in ('super_admin', 'admin') and "customer_id" is null)
  );--> statement-breakpoint

create unique index "auth_users_customer_unique"
  on "auth_users" using btree ("customer_id")
  where "customer_id" is not null;
