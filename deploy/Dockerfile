# One container, two tanks: the read-only party tank and the shared public tank.
# The showcase site itself is plain files, served by your web server (see DEPLOY.md).
FROM python:3.13-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY tank tank
COPY recognizer recognizer
COPY demo demo
COPY deploy/run-tanks.sh /run-tanks.sh
RUN useradd --system --uid 10001 fish && mkdir -p /data && chown fish /data
USER fish
ENV TRUST_PROXY=1 PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
EXPOSE 8001 8002
CMD ["sh", "/run-tanks.sh"]
