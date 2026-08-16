# Reines Python ohne Fremdbibliotheken - deshalb kein Build-Schritt und
# kein Paketmanager im Image. Das Ergebnis ist ein paar Dutzend Megabyte gross.
FROM python:3.12-alpine

# wget fuer den Healthcheck, tzdata damit die Zeitplanung in lokaler Zeit rechnet
RUN apk add --no-cache wget tzdata

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    AIDA_DATA_DIR=/app/data \
    TZ=Europe/Berlin

WORKDIR /app

COPY aida_watch.py server.py config.json ./
COPY web ./web
COPY vorgaben ./vorgaben

# uid 1000, weil das Datenverzeichnis auf dem Server auf 1000:1000 gehoert
RUN addgroup -g 1000 -S aida \
 && adduser -u 1000 -S aida -G aida \
 && mkdir -p /app/data \
 && chown -R aida:aida /app
USER aida

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=5 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/api/gesundheit" >/dev/null || exit 1

CMD ["python3", "server.py"]
