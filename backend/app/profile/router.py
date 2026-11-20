from fastapi import APIRouter, File, HTTPException, Response, UploadFile
from pydantic import BaseModel

from app.auth.deps import current_student
from app.chat.store import ChatStore
from app.profile.store import MAX_AVATAR_BYTES, ProfileStore


class PatchProfile(BaseModel):
    display_name: str


def profile_router(profiles: ProfileStore, chat: ChatStore) -> APIRouter:
    router = APIRouter(prefix="/api/profile", tags=["本机档案"])

    @router.get("")
    def get_profile():
        return {"user": profiles.get(), "onboarding": chat.onboarding_status(current_student())}

    @router.patch("")
    def patch_profile(body: PatchProfile):
        try:
            user = profiles.update_display_name(body.display_name)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None
        return {"user": user}

    @router.post("/avatar")
    async def upload_avatar(file: UploadFile = File(...)):
        data = await file.read(MAX_AVATAR_BYTES + 1)
        if len(data) > MAX_AVATAR_BYTES:
            raise HTTPException(413, "头像图片不能超过 2 MB。")
        try:
            user = profiles.save_avatar(data)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None
        return {"user": user}

    @router.get("/avatar")
    def get_avatar():
        found = profiles.read_avatar()
        if found is None:
            raise HTTPException(404, "尚未上传头像。")
        data, media_type = found
        return Response(
            content=data,
            media_type=media_type,
            headers={"Cache-Control": "public, max-age=31536000, immutable"},
        )

    @router.delete("/avatar")
    def delete_avatar():
        return {"user": profiles.delete_avatar()}

    return router
