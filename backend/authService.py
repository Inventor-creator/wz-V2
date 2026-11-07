
from authlib.integrations.starlette_client import OAuth
import os
from dotenv import load_dotenv
from google.oauth2 import id_token
from google.auth.transport.requests import Request as GoogleRequest

load_dotenv()

oauth = OAuth()

oauth.register(
    name='google',
    client_id=os.getenv("GOOGLE_CLIENT_ID"),
    client_secret=os.getenv("GOOGLE_CLIENT_SECRET"),
    server_metadata_url='https://accounts.google.com/.well-known/openid-configuration',
    client_kwargs={
        'scope': 'openid email profile'
    }
)


def verify_google_id_token(raw_token: str) -> dict:
    """Verify signature, issuer, audience and token lifetime with google-auth.

    OAuth state/nonce are additionally validated by Authlib during code exchange.
    No client-provided userinfo or decoded-but-unverified JWT is accepted.
    """
    audience = os.getenv("GOOGLE_CLIENT_ID")
    if not audience:
        raise RuntimeError("GOOGLE_CLIENT_ID is required")
    claims = id_token.verify_oauth2_token(raw_token, GoogleRequest(), audience=audience)
    if claims.get("email_verified") is not True:
        raise ValueError("Google email is not verified")
    if claims.get("azp") is not None and claims["azp"] != audience:
        raise ValueError("Unexpected authorized party")
    return claims
