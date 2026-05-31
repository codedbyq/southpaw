import httpx
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt

CLERK_JWKS_URL = "https://tolerant-kit-91.clerk.accounts.dev/.well-known/jwks.json"

_jwks_cache: dict | None = None

bearer_scheme = HTTPBearer()


async def get_jwks() -> dict:
    """Fetch and cache Clerk's public JWKS."""
    global _jwks_cache
    if _jwks_cache is None:
        async with httpx.AsyncClient() as client:
            response = await client.get(CLERK_JWKS_URL)
            response.raise_for_status()
            _jwks_cache = response.json()
    return _jwks_cache


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
) -> dict:
    """
    Validate the Clerk JWT from the Authorization: Bearer header.
    Returns the decoded token claims on success.
    """
    token = credentials.credentials
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired token",
        headers={"WWW-Authenticate": "Bearer"},
    )

    try:
        jwks = await get_jwks()
        claims = jwt.decode(
            token,
            jwks,
            algorithms=["RS256"],
            options={"verify_aud": False},
        )
        if claims.get("sub") is None:
            raise credentials_exception
        return claims
    except JWTError:
        raise credentials_exception
