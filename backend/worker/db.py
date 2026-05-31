from contextlib import contextmanager
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session
from core.config import settings

# Sync engine for Celery worker — note no +asyncpg
SYNC_DATABASE_URL = settings.DATABASE_URL.replace("+asyncpg", "")

engine = create_engine(SYNC_DATABASE_URL, pool_pre_ping=True)
SyncSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)


@contextmanager
def get_sync_session() -> Session:
    session = SyncSessionLocal()
    try:
        yield session
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()