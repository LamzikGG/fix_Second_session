from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
import os

# Используем SQLite базу данных
DATABASE_URL = "sqlite:///./chat.db"

# Создаем движок базы данных
engine = create_engine(
    DATABASE_URL, 
    connect_args={"check_same_thread": False},  # Для SQLite
    pool_pre_ping=True  # Проверка соединения перед использованием
)

# Создаем фабрику сессий
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Базовый класс для моделей
Base = declarative_base()

# Dependency для получения сессии базы данных
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()