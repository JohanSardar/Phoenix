# The box the Supabase working copy runs in during a replay: Supabase's own Postgres build of the project's version,
# Node for Supabase's own MCP server and the stand-in API, and libfaketime for the moment's clock.
# Supabase's Postgres is a Nix build; its /nix store is copied onto Debian so Node, Postgres and libfaketime all use glibc.
# Build it with the image of the project's Postgres version (list_tables' server shows it), for example:
#   docker build --build-arg PG_IMAGE=supabase/postgres:17.6.1.166 -t phoenix-supabase:17 plugins/supabase
ARG PG_IMAGE=supabase/postgres:17.6.1.166
FROM ${PG_IMAGE} AS postgres
FROM node:24-bookworm-slim
COPY --from=postgres /nix /nix
RUN apt-get update && apt-get install -y --no-install-recommends libfaketime && \
    mkdir -p /usr/local/lib/faketime && cp /usr/lib/*/faketime/libfaketime.so.1 /usr/local/lib/faketime/ && \
    rm -rf /var/lib/apt/lists/* && \
    printf '#!/bin/sh\necho %s\n' "$(printf '0%.0s' $(seq 64))" > /usr/local/bin/phoenix-pgsodium-getkey && chmod 755 /usr/local/bin/phoenix-pgsodium-getkey && \
    useradd --system --create-home postgres && mkdir -p /var/lib/phoenix && chown postgres:postgres /var/lib/phoenix
ENV PHOENIX_PG_BIN=/nix/var/nix/profiles/default/bin \
    LOCALE_ARCHIVE=/nix/var/nix/profiles/default/lib/locale/locale-archive
USER postgres
RUN $PHOENIX_PG_BIN/initdb -D /var/lib/phoenix/pgdata -U supabase_admin --auth=trust --encoding=UTF-8 --locale-provider=icu --icu-locale=en-US --locale=en_US.UTF-8 >/dev/null
