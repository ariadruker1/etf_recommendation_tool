# Multi-stage build: frontend + backend in one container

# Stage 1: Build frontend
FROM node:20-slim AS frontend
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

# Stage 2: Python backend + serve static
FROM python:3.11-slim
WORKDIR /app

COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./backend/
COPY data/ ./data/
COPY --from=frontend /app/dist ./static/

# Serve frontend static files from FastAPI
RUN echo '\n\
from fastapi.staticfiles import StaticFiles\n\
from fastapi.responses import FileResponse\n\
import os\n\
\n\
static_dir = os.path.join(os.path.dirname(__file__), "..", "static")\n\
if os.path.exists(static_dir):\n\
    from backend.main import app\n\
    @app.get("/{path:path}")\n\
    async def serve_spa(path: str):\n\
        file = os.path.join(static_dir, path)\n\
        if os.path.isfile(file):\n\
            return FileResponse(file)\n\
        return FileResponse(os.path.join(static_dir, "index.html"))\n\
    app.mount("/assets", StaticFiles(directory=os.path.join(static_dir, "assets")), name="assets")\n\
' >> backend/serve.py

EXPOSE 8000

CMD ["python", "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
