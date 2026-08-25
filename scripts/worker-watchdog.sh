#!/bin/sh
set -eu

compose_file=${1:?usage: worker-watchdog.sh COMPOSE_FILE COMPOSE_ENV_FILE APP_VERSION RELEASE_SHA}
compose_env_file=${2:?usage: worker-watchdog.sh COMPOSE_FILE COMPOSE_ENV_FILE APP_VERSION RELEASE_SHA}
APP_VERSION=${3:?usage: worker-watchdog.sh COMPOSE_FILE COMPOSE_ENV_FILE APP_VERSION RELEASE_SHA}
RELEASE_SHA=${4:?usage: worker-watchdog.sh COMPOSE_FILE COMPOSE_ENV_FILE APP_VERSION RELEASE_SHA}

case "$APP_VERSION" in
  *[!0-9a-f]*)
    echo "worker-watchdog: APP_VERSION must be a 7-40 character lowercase Git SHA" >&2
    exit 2
    ;;
esac
if [ "${#APP_VERSION}" -lt 7 ] || [ "${#APP_VERSION}" -gt 40 ]; then
  echo "worker-watchdog: APP_VERSION must be a 7-40 character lowercase Git SHA" >&2
  exit 2
fi
case "$RELEASE_SHA" in
  *[!0-9a-f]*)
    echo "worker-watchdog: RELEASE_SHA must be a full 40 character lowercase Git SHA" >&2
    exit 2
    ;;
esac
if [ "${#RELEASE_SHA}" -ne 40 ]; then
  echo "worker-watchdog: RELEASE_SHA must be a full 40 character lowercase Git SHA" >&2
  exit 2
fi
case "$RELEASE_SHA" in
  "$APP_VERSION"*) ;;
  *)
    echo "worker-watchdog: APP_VERSION and RELEASE_SHA identify different commits" >&2
    exit 2
    ;;
esac
export APP_VERSION RELEASE_SHA

if [ ! -f "$compose_file" ] || [ ! -f "$compose_env_file" ]; then
  echo "worker-watchdog: compose file or environment file is missing" >&2
  exit 2
fi

wait_for_worker_healthy() {
  worker_id=$1
  attempts=0
  while [ "$attempts" -lt 45 ]; do
    worker_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$worker_id" 2>/dev/null || true)
    case "$worker_health" in
      healthy)
        return 0
        ;;
      starting)
        ;;
      *)
        echo "worker-watchdog: worker health verification failed with '$worker_health'" >&2
        return 1
        ;;
    esac
    attempts=$((attempts + 1))
    sleep 2
  done
  echo "worker-watchdog: worker did not become healthy within the watchdog window" >&2
  return 1
}

container_id=$(docker compose --env-file "$compose_env_file" -f "$compose_file" ps -q worker)
if [ -z "$container_id" ]; then
  echo "worker-watchdog: worker container is missing; starting immutable release worker" >&2
  docker compose --env-file "$compose_env_file" -f "$compose_file" up \
    -d --no-build --no-deps worker
  replacement_id=$(docker compose --env-file "$compose_env_file" -f "$compose_file" ps -q worker)
  if [ -z "$replacement_id" ]; then
    echo "worker-watchdog: missing worker start did not produce a container" >&2
    exit 2
  fi
  wait_for_worker_healthy "$replacement_id"
  echo "worker-watchdog: started missing worker $replacement_id" >&2
  exit 0
fi

health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id")
case "$health" in
  healthy|starting)
    exit 0
    ;;
  unhealthy)
    echo "worker-watchdog: recreating unhealthy worker $container_id" >&2
    docker compose --env-file "$compose_env_file" -f "$compose_file" up \
      -d --no-build --no-deps --force-recreate worker
    replacement_id=$(docker compose --env-file "$compose_env_file" -f "$compose_file" ps -q worker)
    if [ -z "$replacement_id" ] || [ "$replacement_id" = "$container_id" ]; then
      echo "worker-watchdog: worker recreation did not produce a new container" >&2
      exit 2
    fi
    wait_for_worker_healthy "$replacement_id"
    echo "worker-watchdog: replaced worker $container_id with $replacement_id" >&2
    ;;
  *)
    echo "worker-watchdog: unexpected worker health '$health'; no automatic action taken" >&2
    exit 2
    ;;
esac
