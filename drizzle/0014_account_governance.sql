update "auth_users"
set
  "role" = case
    when "customer_id" is not null then 'user'
    when coalesce("role", 'user') = 'admin' then 'super_admin'
    else coalesce("role", 'user')
  end,
  "banned" = coalesce("banned", false)
where
  "role" is distinct from case
    when "customer_id" is not null then 'user'
    when coalesce("role", 'user') = 'admin' then 'super_admin'
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
