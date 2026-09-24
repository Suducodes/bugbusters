FROM debian:bookworm-slim

# GNU Octave (MATLAB-compatible engine) + signal package + gnuplot for headless plot export.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      octave octave-signal gnuplot-nox fonts-dejavu-core fonts-freefont-otf \
      python3 python3-flask python3-waitress tzdata iptables \
 && rm -rf /var/lib/apt/lists/*

# Participant code runs as this unprivileged user, with no network access.
RUN useradd --create-home --uid 1500 runner

WORKDIR /app
COPY app.py runner.py /app/
COPY files /files
# Works both as root (docker compose: code runs as `runner`, network blocked) and as an
# unprivileged user (Hugging Face Spaces runs containers as uid 1000).
RUN chmod -R 755 /app && mkdir -p /data && chmod 1777 /data && chmod -R 777 /files

ENV TZ=Asia/Kolkata \
    BB_DATA_DIR=/data \
    BB_FILES_DIR=/files \
    BB_RUNNER_USER=runner \
    BB_PORT=8080 \
    PYTHONUNBUFFERED=1

EXPOSE 8080
CMD ["python3", "app.py"]
