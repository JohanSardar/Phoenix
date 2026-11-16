FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libfaketime && \
    mkdir -p /usr/local/lib/faketime && \
    cp /usr/lib/*/faketime/libfaketime.so.1 /usr/local/lib/faketime/ && \
    rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir mini-swe-agent==2.4.6
