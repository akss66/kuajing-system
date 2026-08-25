#!/bin/sh
set -eu

compose_file=${1:?usage: backup-production.sh COMPOSE_FILE COMPOSE_ENV_FILE BACKUP_DIR [RETENTION_DAYS] [CATALOG_ASSETS_VOLUME]}
compose_env_file=${2:?usage: backup-production.sh COMPOSE_FILE COMPOSE_ENV_FILE BACKUP_DIR [RETENTION_DAYS] [CATALOG_ASSETS_VOLUME]}
backup_dir=${3:?usage: backup-production.sh COMPOSE_FILE COMPOSE_ENV_FILE BACKUP_DIR [RETENTION_DAYS] [CATALOG_ASSETS_VOLUME]}
retention_days=${4:-30}
catalog_assets_volume=${5:-tongzhouxing_shop_catalog_assets}
APP_ENV_FILE="$compose_env_file"
export APP_ENV_FILE

if [ -z "${APP_VERSION:-}" ] || [ -z "${RELEASE_SHA:-}" ]; then
  echo "backup-production: APP_VERSION and RELEASE_SHA are required" >&2
  exit 2
fi
case "$APP_VERSION" in
  *[!0-9a-f]*|'')
    echo "backup-production: APP_VERSION must be a 7-40 character lowercase Git SHA" >&2
    exit 2
    ;;
esac
if [ "${#APP_VERSION}" -lt 7 ] || [ "${#APP_VERSION}" -gt 40 ]; then
  echo "backup-production: APP_VERSION must be a 7-40 character lowercase Git SHA" >&2
  exit 2
fi
case "$RELEASE_SHA" in
  *[!0-9a-f]*|'')
    echo "backup-production: RELEASE_SHA must be a full 40 character lowercase Git SHA" >&2
    exit 2
    ;;
esac
if [ "${#RELEASE_SHA}" -ne 40 ]; then
  echo "backup-production: RELEASE_SHA must be a full 40 character lowercase Git SHA" >&2
  exit 2
fi
case "$RELEASE_SHA" in
  "$APP_VERSION"*) ;;
  *)
    echo "backup-production: APP_VERSION and RELEASE_SHA identify different commits" >&2
    exit 2
    ;;
esac
export APP_VERSION RELEASE_SHA

case "$retention_days" in
  ''|*[!0-9]*)
    echo "backup-production: RETENTION_DAYS must be a positive integer" >&2
    exit 2
    ;;
esac
if [ "$retention_days" -lt 1 ]; then
  echo "backup-production: RETENTION_DAYS must be a positive integer" >&2
  exit 2
fi

case "$catalog_assets_volume" in
  ''|*[!a-zA-Z0-9_.-]*)
    echo "backup-production: CATALOG_ASSETS_VOLUME is invalid" >&2
    exit 2
    ;;
esac

if [ ! -f "$compose_file" ] || [ ! -f "$compose_env_file" ]; then
  echo "backup-production: compose file or environment file is missing" >&2
  exit 2
fi

umask 077
mkdir -p "$backup_dir"
chmod 0750 "$backup_dir"

compose() {
  docker compose --env-file "$compose_env_file" -f "$compose_file" "$@"
}

postgres_container=$(compose ps -q postgres)
if [ -z "$postgres_container" ]; then
  echo "backup-production: postgres service is not running" >&2
  exit 2
fi
if ! docker volume inspect "$catalog_assets_volume" >/dev/null 2>&1; then
  echo "backup-production: catalog assets volume does not exist: $catalog_assets_volume" >&2
  exit 2
fi
archive_image=$(docker inspect --format '{{.Config.Image}}' "$postgres_container")
if [ -z "$archive_image" ]; then
  echo "backup-production: postgres image cannot be resolved" >&2
  exit 2
fi

postgres_user=$(compose exec -T postgres printenv POSTGRES_USER | tr -d '\r')
postgres_db=$(compose exec -T postgres printenv POSTGRES_DB | tr -d '\r')
if [ -z "$postgres_user" ] || [ -z "$postgres_db" ]; then
  echo "backup-production: postgres service is missing POSTGRES_USER or POSTGRES_DB" >&2
  exit 2
fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
set_name="backup-set-$stamp"
staging_dir="$backup_dir/.staging-$set_name-$$"
published_dir="$backup_dir/$set_name"

if [ -e "$published_dir" ]; then
  echo "backup-production: backup set already exists: $published_dir" >&2
  exit 2
fi
mkdir "$staging_dir"

db_name="tongzhouxing-$postgres_db-$stamp.dump"
db_staging_file="$staging_dir/$db_name"
db_staging_sha_file="$db_staging_file.sha256"
container_db_file="/tmp/$db_name"

cleanup() {
  compose exec -T postgres rm -f "$container_db_file" >/dev/null 2>&1 || true
  rm -rf "$staging_dir"
}
trap cleanup EXIT INT TERM

compose exec -T postgres sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-privileges --file="$1"' sh "$container_db_file"
docker cp "${postgres_container}:$container_db_file" "$db_staging_file"
compose exec -T postgres rm -f "$container_db_file"

if [ ! -s "$db_staging_file" ]; then
  echo "backup-production: database backup is empty" >&2
  exit 2
fi
(cd "$staging_dir" && sha256sum "$db_name") > "$db_staging_sha_file"

assets_name="tongzhouxing-catalog-assets-$stamp.tar.gz"
assets_staging_file="$staging_dir/$assets_name"
assets_staging_sha_file="$assets_staging_file.sha256"
docker run --rm \
  --network none \
  -v "$catalog_assets_volume:/from:ro" \
  -v "$staging_dir:/to" \
  "$archive_image" sh -lc "cd /from && tar -czf \"/to/$assets_name\" ."

if [ ! -s "$assets_staging_file" ]; then
  echo "backup-production: catalog assets backup is empty" >&2
  exit 2
fi
(cd "$staging_dir" && sha256sum "$assets_name") > "$assets_staging_sha_file"
touch "$staging_dir/.complete"
mv "$staging_dir" "$published_dir"
trap - EXIT INT TERM

find "$backup_dir" \
  -mindepth 1 \
  -maxdepth 1 \
  -type d \
  -name 'backup-set-*Z' \
  -mtime +"$retention_days" \
  -exec sh -c 'for directory do
    if [ -f "$directory/.complete" ]; then
      rm -rf -- "$directory"
    fi
  done' sh {} +

printf '%s\n' \
  "$published_dir/$db_name" \
  "$published_dir/$db_name.sha256" \
  "$published_dir/$assets_name" \
  "$published_dir/$assets_name.sha256"
