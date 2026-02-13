from fastapi import FastAPI, Depends, HTTPException, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from typing import List, Dict
import json
from datetime import datetime, timedelta

from .database import engine, Base, SessionLocal, get_db
from .models import User, Message, Group, GroupMember, Call, OfflineMessage
from .auth import create_access_token, get_current_user
from .schemas import UserCreate, MessageCreate, GroupCreate
from .utils import success_response

# Создаем все таблицы в базе данных
Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="Chat Messenger API",
    description="WebRTC чат-мессенджер с видеозвонками",
    version="1.0.0"
)

# Единая настройка CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Хранилище соединений
active_connections: List[WebSocket] = []
user_connections: Dict[int, WebSocket] = {}

async def handle_chat_message(message_data: dict, sender_id: int, db: Session):
    """Обработка текстового сообщения"""
    receiver_id = message_data["receiver_id"]
    content = message_data["content"]
    is_group = message_data.get("is_group", False)
    group_id = message_data.get("group_id")
    
    new_message = Message(
        sender_id=sender_id,
        receiver_id=receiver_id,
        content=content,
        is_group=is_group,
        group_id=group_id
    )
    db.add(new_message)
    db.commit()
    db.refresh(new_message)
    
    # Отправляем сообщение получателю, если он онлайн
    if receiver_id in user_connections:
        message_json = {
            "type": "message",
            "message_id": new_message.id,
            "sender_id": sender_id,
            "content": content,
            "created_at": new_message.created_at.isoformat(),
            "is_group": is_group,
            "group_id": group_id
        }
        await user_connections[receiver_id].send_json(message_json)
    else:
        # Сохраняем офлайн сообщение
        offline_msg = OfflineMessage(
            sender_id=sender_id,
            receiver_id=receiver_id,
            content=content,
            delivered=False
        )
        db.add(offline_msg)
        db.commit()
        new_message.is_read = False
        db.commit()

async def handle_call_initiate(call_data: dict, initiator_id: int, db: Session):
    """Обработка инициации звонка"""
    receiver_id = call_data["receiver_id"]
    call_type = call_data["call_type"]
    
    new_call = Call(
        initiator_id=initiator_id,
        receiver_id=receiver_id,
        call_type=call_type,
        status='pending'
    )
    db.add(new_call)
    db.commit()
    db.refresh(new_call)
    
    if receiver_id in user_connections:
        notification = {
            "type": "incoming_call",
            "call_id": new_call.id,
            "initiator_id": initiator_id,
            "call_type": call_type,
            "timestamp": datetime.utcnow().isoformat()
        }
        await user_connections[receiver_id].send_json(notification)
    else:
        new_call.status = 'offline'
        db.commit()

async def handle_call_response(response_data: dict, user_id: int, db: Session):
    """Обработка ответа на звонок"""
    call_id = response_data["call_id"]
    action = response_data["action"]
    sdp = response_data.get("sdp")
    
    call = db.query(Call).filter(Call.id == call_id).first()
    if not call:
        return
    
    if action == "decline":
        call.status = "declined"
        db.commit()
        if call.initiator_id in user_connections:
            await user_connections[call.initiator_id].send_json({
                "type": "call_declined",
                "call_id": call_id
            })
    elif action == "accept":
        call.status = "accepted"
        call.ended_at = None
        db.commit()
        if call.initiator_id in user_connections:
            await user_connections[call.initiator_id].send_json({
                "type": "call_accepted",
                "call_id": call_id,
                "sdp": sdp
            })

async def handle_ice_candidate(candidate_data: dict, user_id: int, db: Session):
    """Обработка ICE кандидата для WebRTC"""
    call_id = candidate_data["call_id"]
    candidate = candidate_data["candidate"]
    target_user_id = candidate_data["target_user_id"]
    
    if target_user_id in user_connections:
        await user_connections[target_user_id].send_json({
            "type": "ice_candidate",
            "call_id": call_id,
            "candidate": candidate,
            "sender_id": user_id
        })

@app.post("/register", response_model=dict)
async def register(user: UserCreate, db: Session = Depends(get_db)):
    existing_user = db.query(User).filter(User.username == user.username).first()
    if existing_user:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Username already registered"
        )
    
    new_user = User(username=user.username)
    new_user.set_password(user.password)
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    
    return success_response(
        data={"user_id": new_user.id, "username": new_user.username},
        message="User registered successfully"
    )

@app.post("/login", response_model=dict)
async def login(form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == form_data.username).first()
    
    if not user or not user.verify_password(form_data.password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    access_token_expires = timedelta(minutes=30)
    access_token = create_access_token(
        data={"sub": user.username}, expires_delta=access_token_expires
    )
    
    user.is_active = True
    db.commit()
    
    return success_response(
        data={
            "access_token": access_token, 
            "token_type": "bearer", 
            "user_id": user.id,
            "username": user.username
        },
        message="Login successful"
    )

@app.get("/users", response_model=dict)
async def get_users(
    current_user: User = Depends(get_current_user), 
    db: Session = Depends(get_db)
):
    users = db.query(User).filter(
        User.id != current_user.id, 
        User.is_active == True
    ).all()
    
    users_list = [
        {
            "id": user.id, 
            "username": user.username,
            "is_online": user.id in user_connections
        } 
        for user in users
    ]
    
    return success_response(data=users_list)

@app.get("/messages/{user_id}", response_model=dict)
async def get_messages(
    user_id: int, 
    current_user: User = Depends(get_current_user), 
    db: Session = Depends(get_db)
):
    messages = db.query(Message).filter(
        ((Message.sender_id == current_user.id) & (Message.receiver_id == user_id)) |
        ((Message.sender_id == user_id) & (Message.receiver_id == current_user.id))
    ).order_by(Message.created_at).all()
    
    messages_list = [
        {
            "id": msg.id,
            "sender_id": msg.sender_id,
            "receiver_id": msg.receiver_id,
            "content": msg.content,
            "is_read": msg.is_read,
            "created_at": msg.created_at.isoformat(),
            "is_group": msg.is_group,
            "group_id": msg.group_id
        } 
        for msg in messages
    ]
    
    # Помечаем сообщения как прочитанные
    unread = db.query(Message).filter(
        Message.sender_id == user_id,
        Message.receiver_id == current_user.id,
        Message.is_read == False
    ).all()
    for msg in unread:
        msg.is_read = True
    db.commit()
    
    return success_response(data=messages_list)

@app.post("/groups/create", response_model=dict)
async def create_group(
    group: GroupCreate, 
    current_user: User = Depends(get_current_user), 
    db: Session = Depends(get_db)
):
    new_group = Group(name=group.name, creator_id=current_user.id)
    db.add(new_group)
    db.commit()
    db.refresh(new_group)
    
    member = GroupMember(user_id=current_user.id, group_id=new_group.id, is_admin=True)
    db.add(member)
    db.commit()
    
    return success_response(
        data={"group_id": new_group.id, "name": new_group.name},
        message="Group created successfully"
    )

@app.post("/groups/invite", response_model=dict)
async def invite_to_group(
    group_id: int, 
    username: str, 
    current_user: User = Depends(get_current_user), 
    db: Session = Depends(get_db)
):
    member = db.query(GroupMember).filter(
        GroupMember.group_id == group_id,
        GroupMember.user_id == current_user.id,
        GroupMember.is_admin == True
    ).first()
    
    if not member:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not admin of this group"
        )
    
    invited_user = db.query(User).filter(User.username == username).first()
    if not invited_user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found"
        )
    
    existing_member = db.query(GroupMember).filter(
        GroupMember.group_id == group_id,
        GroupMember.user_id == invited_user.id
    ).first()
    
    if existing_member:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="User is already in group"
        )
    
    new_member = GroupMember(user_id=invited_user.id, group_id=group_id, is_admin=False)
    db.add(new_member)
    db.commit()
    
    if invited_user.id in user_connections:
        group_name = db.query(Group).filter(Group.id == group_id).first().name
        await user_connections[invited_user.id].send_json({
            "type": "group_invite",
            "group_id": group_id,
            "group_name": group_name,
            "inviter": current_user.username
        })
    
    return success_response(message="User invited successfully")

@app.websocket("/ws/{user_id}")
async def websocket_endpoint(websocket: WebSocket, user_id: int):
    await websocket.accept()
    
    user_connections[user_id] = websocket
    active_connections.append(websocket)
    
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.id == user_id).first()
        if user:
            user.is_active = True
            db.commit()
    finally:
        db.close()
    
    try:
        while True:
            data = await websocket.receive_text()
            message_data = json.loads(data)
            message_type = message_data.get("type")
            
            db = SessionLocal()
            try:
                if message_type == "message":
                    await handle_chat_message(message_data, user_id, db)
                elif message_type == "call_initiate":
                    await handle_call_initiate(message_data, user_id, db)
                elif message_type == "call_response":
                    await handle_call_response(message_data, user_id, db)
                elif message_type == "ice_candidate":
                    await handle_ice_candidate(message_data, user_id, db)
            finally:
                db.close()
                
    except WebSocketDisconnect:
        if user_id in user_connections:
            del user_connections[user_id]
        if websocket in active_connections:
            active_connections.remove(websocket)
        
        db = SessionLocal()
        try:
            user = db.query(User).filter(User.id == user_id).first()
            if user:
                user.is_active = False
                db.commit()
        finally:
            db.close()

@app.on_event("shutdown")
async def shutdown_event():
    for websocket in active_connections:
        try:
            await websocket.close()
        except:
            pass
    
    db = SessionLocal()
    try:
        db.query(User).update({User.is_active: False})
        db.commit()
    finally:
        db.close()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)