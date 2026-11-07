from fastapi import FastAPI

from config import configure_middleware
from Routes.authRoutes import router as auth_router
from Routes.accessRoutes import router as access_router

app = FastAPI(title="MyApp Backend")
configure_middleware(app)

# Include Routers
app.include_router(auth_router)
app.include_router(access_router)


@app.get("/")
def read_root():
    return {"message": "Welcome to MyApp API"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8080, reload=True)
