# build context: repository root
FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml ./
COPY osu2piu ./osu2piu
RUN pip install --no-cache-dir .[api]
ENV PATTERNS_PATH=/data/patterns.pkl \
    CORPUS_STATS=/data/corpus_stats.json
EXPOSE 8000
CMD ["uvicorn", "osu2piu.api:app", "--host", "0.0.0.0", "--port", "8000"]
