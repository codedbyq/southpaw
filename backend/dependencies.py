from clerk_backend_api import AuthenticateRequestOptions, Clerk
from fastapi import HTTPException, Request

from core.config import settings

clerk = Clerk(bearer_auth=settings.CLERK_SECRET_KEY)


async def get_current_user(request: Request) -> str:
    """
    Verify the Clerk JWT attached to the request.
    Returns the clerk_user_id (sub claim) on success.
    """
    request_state = clerk.authenticate_request(
        request,
        AuthenticateRequestOptions(
            authorized_parties=settings.authorized_parties_list
        ),
    )
    if not request_state.is_signed_in:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return request_state.payload.get("sub")
