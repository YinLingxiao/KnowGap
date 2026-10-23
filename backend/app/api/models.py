"""模型库 HTTP 接口。不包含会话模型写入。"""

from fastapi import APIRouter, Request, Response

from app.agents.llm import ChatCompletionsTutor
from app.models.model_library_schemas import (
    CatalogModel, DefaultModelState, DefaultModelUpdate, DeleteProviderResult, ModelCandidate, ModelCreate,
    ModelEntry, ModelTestResult, ModelUpdate, ProviderCreate, ProviderPublic, ProviderUpdate, ServiceModelSelection,
    TestModelRequest,
)

_PROBE = {
    "phase": "initial", "current_answer": "栈遵循后进先出。",
    "problem": {"prompt": "说明栈的出入顺序。"},
    "reference": {"explanation": "栈遵循后进先出。"},
    "history": [], "memories": [],
}


def models_router(library, guard, chatgpt_auth):
    router = APIRouter(prefix="/api/models", tags=["模型库"])

    def local(request: Request, response: Response) -> None:
        guard(request)
        response.headers["Cache-Control"] = "no-store"

    @router.get("", response_model=list[CatalogModel])
    @router.get("/", response_model=list[CatalogModel], include_in_schema=False)
    def catalog(request: Request, response: Response):
        local(request, response)
        return library.catalog()

    @router.get("/providers", response_model=list[ProviderPublic])
    def list_providers(request: Request, response: Response):
        local(request, response)
        return library.public_providers()

    @router.post("/providers", response_model=ProviderPublic)
    def create_provider(request: Request, response: Response, body: ProviderCreate):
        local(request, response)
        return library.create_provider(body).public()

    @router.patch("/providers/{provider_id}", response_model=ProviderPublic)
    def update_provider(provider_id: str, request: Request, response: Response, body: ProviderUpdate):
        local(request, response)
        return library.update_provider(provider_id, body).public()

    @router.delete("/providers/{provider_id}", response_model=DeleteProviderResult)
    def delete_provider(provider_id: str, request: Request, response: Response):
        local(request, response)
        return library.delete_provider(provider_id)

    @router.post("/providers/{provider_id}/models", response_model=ModelEntry)
    def create_model(provider_id: str, request: Request, response: Response, body: ModelCreate):
        local(request, response)
        return library.create_model(provider_id, body)

    @router.patch("/providers/{provider_id}/models/{model_id:path}", response_model=ModelEntry)
    def update_model(provider_id: str, model_id: str, request: Request, response: Response, body: ModelUpdate):
        local(request, response)
        return library.update_model(provider_id, model_id, body)

    @router.delete("/providers/{provider_id}/models/{model_id:path}", response_model=DeleteProviderResult)
    def delete_model(provider_id: str, model_id: str, request: Request, response: Response):
        local(request, response)
        return library.delete_model(provider_id, model_id)

    @router.post("/providers/{provider_id}/fetch", response_model=list[ModelCandidate])
    def fetch_models(provider_id: str, request: Request, response: Response):
        local(request, response)
        return library.fetch(provider_id)

    @router.post("/providers/{provider_id}/test", response_model=ModelTestResult)
    async def test_model(provider_id: str, request: Request, response: Response, body: TestModelRequest):
        local(request, response)
        candidate = library.settings_for(provider_id, body.model_id)
        await ChatCompletionsTutor(candidate, chatgpt_auth=chatgpt_auth).generate(_PROBE)
        return ModelTestResult(model=candidate.llm_model, structured_output=True)

    @router.get("/default", response_model=DefaultModelState)
    def get_default(request: Request, response: Response):
        local(request, response)
        return DefaultModelState(key=library.get_default())

    @router.put("/default", response_model=DefaultModelState)
    def put_default(request: Request, response: Response, body: DefaultModelUpdate):
        local(request, response)
        return DefaultModelState(key=library.set_default(body.key))

    @router.get("/service", response_model=ServiceModelSelection)
    def get_service(request: Request, response: Response):
        local(request, response)
        return library.get_service()

    @router.put("/service", response_model=ServiceModelSelection)
    def put_service(request: Request, response: Response, body: ServiceModelSelection):
        local(request, response)
        return library.set_service(body)

    return router
