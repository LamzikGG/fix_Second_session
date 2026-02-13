from pydantic import BaseModel
from datetime import datetime
from typing import Optional

# User schemas
class UserBase(BaseModel):
    username: str

class UserCreate(UserBase):
    password: str

class User(UserBase):
    id: int
    is_active: bool
    created_at: datetime
    
    class Config:
        from_attributes = True

# Message schemas
class MessageBase(BaseModel):
    content: str
    receiver_id: int
    is_group: Optional[bool] = False
    group_id: Optional[int] = None

class MessageCreate(MessageBase):
    pass

class Message(MessageBase):
    id: int
    sender_id: int
    is_read: bool
    created_at: datetime
    
    class Config:
        from_attributes = True

# Group schemas
class GroupBase(BaseModel):
    name: str

class GroupCreate(GroupBase):
    pass

class Group(GroupBase):
    id: int
    creator_id: int
    created_at: datetime
    
    class Config:
        from_attributes = True

# Call schemas
class CallBase(BaseModel):
    receiver_id: int
    call_type: str  # 'video' or 'audio'

class CallCreate(CallBase):
    pass

class Call(CallBase):
    id: int
    initiator_id: int
    status: str
    created_at: datetime
    ended_at: Optional[datetime] = None
    
    class Config:
        from_attributes = True

# Token schemas
class Token(BaseModel):
    access_token: str
    token_type: str
    user_id: int

class TokenData(BaseModel):
    username: Optional[str] = None