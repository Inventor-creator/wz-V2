# MyApp Backend

A FastAPI + SQLAlchemy + PostgreSQL API scaffold with Google OAuth login.

This is a **skeleton**: the infrastructure is wired up and working, while all
domain modules have been gutted to empty stubs. Fill in the `TODO`s to build
your own feature set.

## Stack

- **FastAPI** app server
- **SQLAlchemy 2.0** ORM (mapped-column style)
- **PostgreSQL** database
- **Authlib** Google OAuth 2.0 with server-side session cookies

## What is already working

| Area | File | Status |
|------|------|--------|
| App wiring, middleware, CORS | `main.py` | Ready |
| Google OAuth client | `authService.py` | Ready |
| DB engine + session | `database/__init__.py` | Ready |
| `User` model + auth model | `database/models.py` | Ready |
| OAuth login/callback/logout/me | `Routes/authRoutes.py` | Ready |

## What you need to implement

- **`database/models.py`** — add columns/relationships to the shell models
- **`schemas/*.py`** — define Pydantic request/response schemas
- **`Routes/*.py`** — implement the CRUD endpoint stubs
- Register new routers in `main.py`

## Setup

```bash
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env            # fill in DATABASE_URL, Google OAuth creds
python main.py
```

The API will be available at `http://localhost:8080` (Swagger docs at
`/docs`).

## Project Structure

```
backend/
├── main.py                 # FastAPI app entry point, middleware, router registration
├── authService.py          # Google OAuth client configuration
├── requirements.txt
├── database/
│   └── models.py           # SQLAlchemy models (User kept, domain models stubbed)
├── schemas/                # Pydantic request/response schemas (stubbed)
└── Routes/                 # FastAPI routers (auth wired, CRUD stubbed)
```

## Conventions

- Authenticated user is stored in `request.session["user"]` by the auth
  callback. Read it in endpoints with `request.session.get("user")`.
- Multi-entity scoping in the original project used an `X-Gym-Id` request
  header set by the frontend. The same pattern can be reused for any
  "active workspace" concept.
- Tables are created with `Base.metadata.create_all` on `python main.py`.
  Use Alembic for real migrations in production.
