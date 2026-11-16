FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libfaketime && \
    mkdir -p /usr/local/lib/faketime && \
    cp /usr/lib/*/faketime/libfaketime.so.1 /usr/local/lib/faketime/ && \
    rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir openai-agents==0.24.0 openai-chatkit==1.6.5 pydantic
