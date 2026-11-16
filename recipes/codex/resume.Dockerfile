FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libfaketime && \
    mkdir -p /usr/local/lib/faketime && \
    cp /usr/lib/*/faketime/libfaketime.so.1 /usr/local/lib/faketime/ && \
    rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts @openai/codex@0.169.0
RUN ln -s /phoenix/recipe/shell.mjs /bin/zsh && sed -i 's#^root:\(.*\):/bin/bash$#root:\1:/bin/zsh#' /etc/passwd
