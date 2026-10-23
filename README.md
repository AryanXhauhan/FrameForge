# FrameForge ⚡ 
### Production-Grade Media Processing, AI Narrative & Video Export Backend

[![Live Demo](https://img.shields.io/badge/Demo-Live_on_Render-blueviolet?style=for-the-badge&logo=render)](https://frameforge-boo4.onrender.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22-green?style=for-the-badge&logo=node.js)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Neon_Cloud-4169E1?style=for-the-badge&logo=postgresql)](https://neon.tech/)
[![Redis](https://img.shields.io/badge/Redis-Upstash_Cloud-DC382D?style=for-the-badge&logo=redis)](https://upstash.com/)
[![FFmpeg](https://img.shields.io/badge/FFmpeg-Native_Linux-007808?style=for-the-badge&logo=ffmpeg)](https://ffmpeg.org/)
[![Gemini](https://img.shields.io/badge/AI-Google_Gemini_3.8_Flash-orange?style=for-the-badge&logo=google)](https://deepmind.google/technologies/gemini/)

> **Live Deployment:** [https://frameforge-boo4.onrender.com](https://frameforge-boo4.onrender.com)

FrameForge is a high-throughput, fault-tolerant video processing & export engine designed for modern web video editing suites. Built around asynchronous background queues (`BullMQ`), strict state-machine lifecycle enforcement, double-entry transactional credit ledgers, live multimodal AI scene recognition, and programmatic FFmpeg rendering.

---

## 🌟 Key Features

### 1. 🎞️ High-Throughput Media Processing (FFmpeg)
- **Proxy Generation**: Fast 360p H.264 proxy transcoding with audio normalization and keyframe alignment.
- **Master Video Export**: Full HD/4K multi-threaded video rendering with configurable bitrates, FPS normalization, and frame-accurate letterboxing.
- **Sub-task Thumbnail Pipelines**: Parallel thumbnail extraction and storyboard poster frames.
- **Direct One-Click Device Download**: Download proxy clips, exported master videos, or AI analysis JSON files straight from the dashboard.

### 2. 🧠 Multimodal AI Scene & Narrative Recognition
- Powered by **Google Gemini 3.8 Flash** with automatic failover to OpenAI / Mock providers.
- Extracts timestamps, video synopsis, individual scene tags, and narrative transitions in structured JSON.

### 3. 💳 Financial-Grade Credit & Reservation Ledger
- **Two-Phase Commit Locking**: Reserves credits before job enqueue (`credit_ledger`) and permanently settles them only upon verified completion.
- **Automatic Refund Guarantee**: Any job failure, worker crash, or cancellation immediately refunds reserved credits.
- **Anti Double-Spend Defense**: PostgreSQL transactional row-level isolation ensures multiple concurrent clicks never over-draw account balance.

### 4. ⚡ Real-Time WebSockets & ETA Countdown Engine
- Live progress streaming over **Socket.IO** with true honest duration/ETA calculation.
- Auto-reconnecting live tickers tracking CPU duration, remaining seconds, and step-by-step pipeline stages.

### 5. 🛡️ Fault Tolerance & Idempotency
- **Idempotency-Key Protection**: Submitting identical requests with the same key returns the existing job without deducting double credits.
- **Worker Crash Recovery**: Stall detection and automatic retry loop with exponential backoff.
- **Clean State Management**: Interactive controls to Cancel running jobs, Retry failed attempts, and Delete stale projects or media.

---

## 🏗️ System Architecture

```mermaid
graph TD
    Client[Web UI / REST Client] -->|HTTP REST API| API[Express API Server]
    Client <-->|WebSockets (Socket.IO)| API
    
    API -->|Prisma ORM (Row Locking)| DB[(Neon PostgreSQL)]
    API -->|Enqueue & Idempotency Locks| Redis[(Upstash Redis)]
    
    subgraph BullMQ Distributed Queues
        Q_Proxy[Proxy Queue]
        Q_Transcode[Transcode Queue]
        Q_AI[AI Analysis Queue]
        Q_Export[Export Queue]
    end
    
    Redis --> Q_Proxy
    Redis --> Q_Transcode
    Redis --> Q_AI
    Redis --> Q_Export
    
    subgraph Background Workers
        W_Proxy[Proxy Worker (FFmpeg)]
        W_Transcode[Transcode Worker]
        W_AI[AI Worker (Gemini 3.8 Flash)]
        W_Export[Export Worker (FFmpeg Multi-pass)]
    end
    
    Q_Proxy --> W_Proxy
    Q_Transcode --> W_Transcode
    Q_AI --> W_AI
    Q_Export --> W_Export
    
    W_Proxy -->|Storage| Vol[(Disk / Storage)]
    W_Export -->|Storage| Vol
    
    Workers -->|Progress & Audit Events| Redis
    Redis -->|Pub/Sub Event Bus| API
    API -->|Real-Time Progress / ETA| Client
```

---

## 🚀 Live Demo & API Endpoints

### 🌐 Live Dashboard
Open **[https://frameforge-boo4.onrender.com](https://frameforge-boo4.onrender.com)** to test the full web interface:
1. Upload any sample MP4/MOV video.
2. Trigger **Transcode Proxy** (2 Credits), **AI Narrative** (5 Credits), or **Master Export** (10 Credits).
3. Watch the real-time ETA countdown and download the final processed file using the **📥 Download** button!

### 📡 Core API Specification

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/credits` | Fetch available balance and transaction logs |
| `POST` | `/api/credits/reset` | Instantly reset/refill credit balance |
| `POST` | `/api/projects` | Create a new video editing project |
| `POST` | `/api/projects/:id/media` | Upload and probe video file via FFprobe |
| `POST` | `/api/media/:id/proxy` | Queue 360p Proxy Generation job |
| `POST` | `/api/media/:id/analyze` | Queue AI Scene & Narrative job (Gemini) |
| `POST` | `/api/projects/:id/export` | Queue Final Video Export job (1080p/4K) |
| `GET` | `/api/jobs/:id/download` | **Direct file download of completed video/data** |
| `POST` | `/api/jobs/:id/cancel` | Cancel in-flight job & refund reserved credits |
| `POST` | `/api/jobs/:id/retry` | Re-queue a failed job |
| `DELETE` | `/api/jobs/:id` | Delete job record |
| `DELETE` | `/api/media/:id` | Delete uploaded media asset & disk variants |

---

## 🛠️ Local Development Setup

### 1. Prerequisites
- **Node.js**: v20 or v22+
- **PostgreSQL**: Local database or free [Neon DB](https://neon.tech)
- **Redis**: Local redis-server or free [Upstash Redis](https://upstash.com)
- **FFmpeg**: Installed and available in your system `PATH`

### 2. Clone and Install
```bash
git clone https://github.com/AryanXhauhan/FrameForge.git
cd FrameForge
npm install
```

### 3. Configure Environment Variables
Copy `.env.example` to `.env`:
```ini
PORT=4000
NODE_ENV=development
DATABASE_URL="postgresql://user:password@localhost:5432/frameforge?sslmode=require"
REDIS_URL="redis://127.0.0.1:6379"
JWT_SECRET="super-secret-frameforge-jwt-key-32chars"
UPLOAD_DIR="./storage/uploads"
OUTPUT_DIR="./storage/outputs"
AI_PROVIDER="auto"
GEMINI_API_KEY="your-gemini-api-key"
OPENAI_API_KEY="your-openai-api-key"
CORS_ORIGIN="http://localhost:4000"
```

### 4. Database Setup & Migrations
```bash
npx prisma generate
npx prisma db push
```

### 5. Start Development Server
```bash
# Start API Server with Watch Mode
npm run dev

# (Optional) Run Worker process standalone
npm run dev:worker
```
Open **`http://localhost:4000`** in your browser.

---

## 🧪 Testing Suite

FrameForge includes a comprehensive suite of unit and end-to-end integration tests:

```bash
# Run all unit & state machine tests
npm run test:unit

# Run full integration tests with credit ledger verification
npm run test:integration

# Run entire test suite
npm run test
```

---

## 📦 Docker Deployment

FrameForge includes a production-ready multi-stage Linux container with embedded FFmpeg & FFprobe:

```bash
# Build Docker image
docker build -t frameforge:latest .

# Run container
docker run -p 4000:4000 --env-file .env frameforge:latest
```

---

## 📄 License
This project is open-source under the [MIT License](LICENSE).
