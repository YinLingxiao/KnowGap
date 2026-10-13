# KnowGap

> AI 驱动的知识盲区诊断与学习引导系统

## 项目结构

```
KnowGap/
├── frontend/               # Next.js 前端
├── backend/                # FastAPI 后端
│   ├── app/
│   │   ├── api/            # API 路由
│   │   ├── agents/         # AI 诊断与引导
│   │   ├── memory/         # 长期记忆治理
│   │   ├── models/         # 数据结构
│   │   └── services/       # 业务逻辑
│   └── tests/
│
├── docs/
│   ├── research/           # 四人调研成果
│   ├── architecture.md     # 系统架构
│   ├── api.md              # 接口约定
│   └── decisions.md        # 技术决策记录
│
├── demo/                   # 演示数据与样例
├── .gitignore
├── .env.example
└── README.md
```

## 快速开始

### 后端（FastAPI）

```bash
cd backend
python -m venv .venv
source .venv/Scripts/activate   # Windows Git Bash
pip install -r requirements.txt
uvicorn app.main:app --reload
```

### 前端（Next.js）

```bash
cd frontend
npm install
npm run dev
```

## 文档

- [系统架构](docs/architecture.md)
- [接口约定](docs/api.md)
- [技术决策记录](docs/decisions.md)
