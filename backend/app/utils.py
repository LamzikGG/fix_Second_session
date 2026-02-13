from datetime import datetime
from typing import List, Dict, Any

def format_datetime(dt: datetime) -> str:
    """Форматирование даты и времени в строку ISO"""
    return dt.isoformat() if dt else None

def success_response(data: Any = None, message: str = "Success") -> Dict[str, Any]:
    """Формирование успешного ответа"""
    return {
        "success": True,
        "message": message,
        "data": data
    }

def error_response(message: str, status_code: int = 400) -> Dict[str, Any]:
    """Формирование ошибочного ответа"""
    return {
        "success": False,
        "message": message,
        "status_code": status_code
    }

def paginate_query(query, page: int = 1, page_size: int = 20):
    """Пагинация запроса к базе данных"""
    offset = (page - 1) * page_size
    return query.offset(offset).limit(page_size)