from .base import FileBackend, FileItem, BackendError
from .ftp_backend import FTPBackend


class BackendFactory:
    _registry: dict[str, type[FileBackend]] = {}

    @classmethod
    def register(cls, name: str, backend_cls: type[FileBackend]) -> None:
        cls._registry[name] = backend_cls

    @classmethod
    async def create(cls, backend_type: str, params: dict) -> FileBackend:
        if backend_type not in cls._registry:
            raise ValueError(f"Unknown backend type: {backend_type}")
        be = cls._registry[backend_type]()
        await be.connect(params)
        return be


BackendFactory.register("ftp", FTPBackend)
