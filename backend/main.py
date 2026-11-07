from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.sessions import SessionMiddleware
import os
from dotenv import load_dotenv

from Routes.authRoutes import router as auth_router


load_dotenv()

app = FastAPI(title="MyApp Backend")

# Add Session Middleware
app.add_middleware(
    SessionMiddleware,
    secret_key=os.getenv("SECRET_KEY") or "",
    session_cookie="secure_session",
    max_age=3600,
    same_site="lax",
    https_only=False,
    domain=None,
)

# Add CORS Middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.getenv("FRONTEND_URL", "http://localhost:5173")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include Routers
app.include_router(auth_router)

@app.get("/")
def read_root():
    return {"message": "Welcome to MyApp API"}


if __name__ == "__main__":
    import uvicorn
    from database import models, engine

    models.Base.metadata.create_all(bind=engine)
    uvicorn.run(app, host="0.0.0.0", port=8080, reload=True)
