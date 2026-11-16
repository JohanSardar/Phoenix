FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libfaketime && \
    mkdir -p /usr/local/lib/faketime && \
    cp /usr/lib/*/faketime/libfaketime.so.1 /usr/local/lib/faketime/ && \
    rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts @openai/codex@0.169.0
RUN cp /usr/bin/dash /usr/local/lib/phoenix-dash && \
    printf '#!/usr/local/lib/phoenix-dash\nif [ -n "$PHOENIX_CODEX_SHELL" ]; then exec /phoenix/recipe/shell.mjs "$@"; fi\nexec /usr/local/lib/phoenix-dash "$@"\n' > /usr/local/bin/phoenix-sh && \
    chmod 755 /usr/local/bin/phoenix-sh && ln -sf /usr/local/bin/phoenix-sh /usr/bin/dash && ln -sf /usr/local/bin/phoenix-sh /usr/bin/sh
RUN for shell in /bin/zsh /usr/bin/zsh /bin/bash /usr/bin/bash; do ln -sf /phoenix/recipe/shell.mjs $shell; done && sed -i 's#^root:\(.*\):/bin/bash$#root:\1:/bin/zsh#' /etc/passwd
