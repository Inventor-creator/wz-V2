from fastapi import FastAPI

from config import configure_middleware
from Routes.authRoutes import router as auth_router
from Routes.accessRoutes import router as access_router
from Routes.trainerRoutes import router as trainer_router
from Routes.membershipRoutes import router as membership_router
from Routes.trainerPlanRoutes import router as trainer_plan_router
from Routes.trainerManagementRoutes import router as trainer_management_router
from Routes.memberRoutes import router as member_router
from Routes.financialRoutes import router as financial_router

app = FastAPI(title="MyApp Backend")
configure_middleware(app)

# Include Routers
app.include_router(auth_router)
app.include_router(access_router)
app.include_router(trainer_router)
app.include_router(membership_router)
app.include_router(trainer_plan_router)
app.include_router(trainer_management_router)
app.include_router(member_router)
app.include_router(financial_router)


@app.get("/")
def read_root():
    return {"message": "Welcome to MyApp API"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8080, reload=True)
