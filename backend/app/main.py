from fastapi import FastAPI, Depends, HTTPException, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from typing import List, Dict
import json
from datetime import datetime, timedelta
from .database import engine, Base, SessionLocal, get_db
from .models import User, Message, Group, GroupMember, Call, OfflineMessage, Friendship
from .auth import create_access_token, get_current_user
from .schemas import UserCreate, MessageCreate, GroupCreate, GroupMemberAdd, FriendRequest
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

# ==================== АВТОРИЗАЦИЯ ====================
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

# ==================== ПОИСК ПОЛЬЗОВАТЕЛЕЙ ====================
@app.get("/users/search", response_model=dict)
async def search_users(
    q: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Поиск пользователей по логину"""
    if not q or len(q) < 2:
        return success_response(data=[])
    
    users = db.query(User).filter(
        User.username.ilike(f"%{q}%"),
        User.id != current_user.id,
        User.is_active == True
    ).limit(20).all()
    
    users_list = [
        {
            "id": user.id,
            "username": user.username,
            "is_online": user.id in user_connections,
            "status": "online" if user.id in user_connections else "offline"
        }
        for user in users
    ]
    
    return success_response(data=users_list)

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
            "is_online": user.id in user_connections,
            "status": "online" if user.id in user_connections else "offline"
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
    """История личных сообщений 1-на-1"""
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
    
    # Помечаем личные входящие сообщения как прочитанные
    unread = db.query(Message).filter(
        Message.sender_id == user_id,
        Message.receiver_id == current_user.id,
        Message.is_read == False
    ).all()
    
    for msg in unread:
        msg.is_read = True
    db.commit()
    
    return success_response(data=messages_list)


@app.get("/groups/{group_id}/messages", response_model=dict)
async def get_group_messages(
    group_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    История сообщений группы.
    Возвращает сообщения только если текущий пользователь является участником группы.
    """
    membership = db.query(GroupMember).filter(
        GroupMember.group_id == group_id,
        GroupMember.user_id == current_user.id
    ).first()
    
    if not membership:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not a member of this group"
        )
    
    group_messages = db.query(Message).filter(
        Message.group_id == group_id
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
        for msg in group_messages
    ]
    
    return success_response(data=messages_list)

# ==================== ДРУЗЬЯ ====================
@app.post("/friends/add", response_model=dict)
async def add_friend(
    friend_data: FriendRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Отправить запрос в друзья"""
    friend_id = friend_data.friend_id
    
    if friend_id == current_user.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot add yourself as friend"
        )
    
    friend = db.query(User).filter(User.id == friend_id).first()
    if not friend:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found"
        )
    
    # Проверяем, нет ли уже запроса
    existing = db.query(Friendship).filter(
        ((Friendship.user_id == current_user.id) & (Friendship.friend_id == friend_id)) |
        ((Friendship.user_id == friend_id) & (Friendship.friend_id == current_user.id))
    ).first()
    
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Friend request already exists"
        )
    
    # Создаем запрос
    friendship = Friendship(
        user_id=current_user.id,
        friend_id=friend_id,
        status='pending'
    )
    db.add(friendship)
    db.commit()
    
    # Уведомляем через WebSocket
    if friend_id in user_connections:
        await user_connections[friend_id].send_json({
            "type": "friend_request",
            "from_user_id": current_user.id,
            "from_username": current_user.username
        })
    
    return success_response(message="Friend request sent")

@app.get("/friends", response_model=dict)
async def get_friends(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Получить список друзей"""
    friendships = db.query(Friendship).filter(
        ((Friendship.user_id == current_user.id) | (Friendship.friend_id == current_user.id)) &
        (Friendship.status == 'accepted')
    ).all()
    
    friends = []
    for friendship in friendships:
        friend_id = friendship.friend_id if friendship.user_id == current_user.id else friendship.user_id
        friend = db.query(User).filter(User.id == friend_id).first()
        
        if friend:
            friends.append({
                "id": friend.id,
                "username": friend.username,
                "is_online": friend.id in user_connections,
                "status": "online" if friend.id in user_connections else "offline"
            })
    
    return success_response(data=friends)

@app.get("/friends/requests", response_model=dict)
async def get_friend_requests(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Получить входящие запросы в друзья"""
    requests = db.query(Friendship).filter(
        Friendship.friend_id == current_user.id,
        Friendship.status == 'pending'
    ).all()
    
    requests_list = []
    for req in requests:
        user = db.query(User).filter(User.id == req.user_id).first()
        if user:
            requests_list.append({
                "friendship_id": req.id,
                "user_id": user.id,
                "username": user.username
            })
    
    return success_response(data=requests_list)

@app.post("/friends/accept/{friendship_id}", response_model=dict)
async def accept_friend_request(
    friendship_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Принять запрос в друзья"""
    friendship = db.query(Friendship).filter(
        Friendship.id == friendship_id,
        Friendship.friend_id == current_user.id,
        Friendship.status == 'pending'
    ).first()
    
    if not friendship:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Friend request not found"
        )
    
    friendship.status = 'accepted'
    db.commit()
    
    # Уведомляем инициатора
    if friendship.user_id in user_connections:
        await user_connections[friendship.user_id].send_json({
            "type": "friend_accepted",
            "friendship_id": friendship_id,
            "friend_id": current_user.id,
            "friend_username": current_user.username
        })
    
    return success_response(message="Friend added")

@app.delete("/friends/{friend_id}", response_model=dict)
async def remove_friend(
    friend_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Удалить друга"""
    friendship = db.query(Friendship).filter(
        ((Friendship.user_id == current_user.id) & (Friendship.friend_id == friend_id)) |
        ((Friendship.user_id == friend_id) & (Friendship.friend_id == current_user.id))
    ).first()
    
    if not friendship:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Friendship not found"
        )
    
    db.delete(friendship)
    db.commit()
    
    return success_response(message="Friend removed")

# ==================== ГРУППЫ ====================
@app.get("/groups", response_model=dict)
async def get_user_groups(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Получить список групп пользователя"""
    memberships = db.query(GroupMember).filter(
        GroupMember.user_id == current_user.id
    ).all()
    
    groups = []
    for membership in memberships:
        group = db.query(Group).filter(Group.id == membership.group_id).first()
        if group:
            members_count = db.query(GroupMember).filter(
                GroupMember.group_id == group.id
            ).count()
            
            groups.append({
                "id": group.id,
                "name": group.name,
                "creator_id": group.creator_id,
                "is_admin": membership.is_admin,
                "members_count": members_count,
                "created_at": group.created_at.isoformat()
            })
    
    return success_response(data=groups)

@app.post("/groups/create", response_model=dict)
async def create_group(
    group: GroupCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Создать группу с участниками"""
    new_group = Group(name=group.name, creator_id=current_user.id)
    db.add(new_group)
    db.commit()
    db.refresh(new_group)
    
    # Добавляем создателя как админа
    member = GroupMember(user_id=current_user.id, group_id=new_group.id, is_admin=True)
    db.add(member)
    db.commit()
    
    # Добавляем участников по логинам
    if group.members:
        for username in group.members:
            user = db.query(User).filter(User.username == username).first()
            if user and user.id != current_user.id:
                new_member = GroupMember(user_id=user.id, group_id=new_group.id, is_admin=False)
                db.add(new_member)
                
                # Уведомляем участника
                if user.id in user_connections:
                    await user_connections[user.id].send_json({
                        "type": "group_invite",
                        "group_id": new_group.id,
                        "group_name": new_group.name,
                        "inviter": current_user.username
                    })
        
        db.commit()
    
    return success_response(
        data={"group_id": new_group.id, "name": new_group.name},
        message="Group created successfully"
    )

@app.get("/groups/{group_id}", response_model=dict)
async def get_group_info(
    group_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Получить информацию о группе"""
    membership = db.query(GroupMember).filter(
        GroupMember.group_id == group_id,
        GroupMember.user_id == current_user.id
    ).first()
    
    if not membership:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not a member of this group"
        )
    
    group = db.query(Group).filter(Group.id == group_id).first()
    members_count = db.query(GroupMember).filter(
        GroupMember.group_id == group_id
    ).count()
    
    return success_response(data={
        "id": group.id,
        "name": group.name,
        "creator_id": group.creator_id,
        "is_admin": membership.is_admin,
        "members_count": members_count,
        "created_at": group.created_at.isoformat()
    })

@app.get("/groups/{group_id}/members", response_model=dict)
async def get_group_members(
    group_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Получить участников группы"""
    membership = db.query(GroupMember).filter(
        GroupMember.group_id == group_id,
        GroupMember.user_id == current_user.id
    ).first()
    
    if not membership:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not a member of this group"
        )
    
    members = db.query(GroupMember).filter(
        GroupMember.group_id == group_id
    ).all()
    
    members_list = []
    for member in members:
        user = db.query(User).filter(User.id == member.user_id).first()
        if user:
            members_list.append({
                "id": user.id,
                "username": user.username,
                "is_admin": member.is_admin,
                "is_online": user.id in user_connections,
                "status": "online" if user.id in user_connections else "offline",
                "joined_at": member.joined_at.isoformat()
            })
    
    return success_response(data=members_list)

@app.post("/groups/{group_id}/members", response_model=dict)
async def add_group_member(
    group_id: int,
    member_data: GroupMemberAdd,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Добавить участника в группу (только для админов)"""
    admin_membership = db.query(GroupMember).filter(
        GroupMember.group_id == group_id,
        GroupMember.user_id == current_user.id,
        GroupMember.is_admin == True
    ).first()
    
    if not admin_membership:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can add members"
        )
    
    user_login = member_data.user_login
    user_id = member_data.user_id
    
    if user_login:
        user = db.query(User).filter(User.username == user_login).first()
    elif user_id:
        user = db.query(User).filter(User.id == user_id).first()
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="user_login or user_id is required"
        )
    
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found"
        )
    
    existing = db.query(GroupMember).filter(
        GroupMember.group_id == group_id,
        GroupMember.user_id == user.id
    ).first()
    
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="User is already a member"
        )
    
    new_member = GroupMember(
        user_id=user.id,
        group_id=group_id,
        is_admin=False
    )
    db.add(new_member)
    db.commit()
    
    # Уведомляем через WebSocket
    if user.id in user_connections:
        group = db.query(Group).filter(Group.id == group_id).first()
        await user_connections[user.id].send_json({
            "type": "group_invite",
            "group_id": group_id,
            "group_name": group.name,
            "inviter": current_user.username
        })
    
    return success_response(message="Member added successfully")

@app.delete("/groups/{group_id}/members/{user_id}", response_model=dict)
async def remove_group_member(
    group_id: int,
    user_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Удалить участника из группы (только для админов)"""
    admin_membership = db.query(GroupMember).filter(
        GroupMember.group_id == group_id,
        GroupMember.user_id == current_user.id,
        GroupMember.is_admin == True
    ).first()
    
    if not admin_membership:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can remove members"
        )
    
    group = db.query(Group).filter(Group.id == group_id).first()
    if group.creator_id == user_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot remove group creator"
        )
    
    membership = db.query(GroupMember).filter(
        GroupMember.group_id == group_id,
        GroupMember.user_id == user_id
    ).first()
    
    if not membership:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Member not found"
        )
    
    db.delete(membership)
    db.commit()
    
    # Уведомляем участника
    if user_id in user_connections:
        await user_connections[user_id].send_json({
            "type": "removed_from_group",
            "group_id": group_id,
            "group_name": group.name
        })
    
    return success_response(message="Member removed")

@app.post("/groups/{group_id}/leave", response_model=dict)
async def leave_group(
    group_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Выйти из группы"""
    membership = db.query(GroupMember).filter(
        GroupMember.group_id == group_id,
        GroupMember.user_id == current_user.id
    ).first()
    
    if not membership:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="You are not a member of this group"
        )
    
    group = db.query(Group).filter(Group.id == group_id).first()
    if group.creator_id == current_user.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Creator cannot leave group. Delete the group instead."
        )
    
    db.delete(membership)
    db.commit()
    
    return success_response(message="Left group successfully")

@app.delete("/groups/{group_id}", response_model=dict)
async def delete_group(
    group_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Удалить группу (только создатель)"""
    group = db.query(Group).filter(Group.id == group_id).first()
    
    if not group:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Group not found"
        )
    
    if group.creator_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only group creator can delete the group"
        )
    
    # Удаляем всех участников
    db.query(GroupMember).filter(
        GroupMember.group_id == group_id
    ).delete()
    
    # Удаляем группу
    db.delete(group)
    db.commit()
    
    # Уведомляем всех участников
    for conn_user_id, websocket in user_connections.items():
        try:
            await websocket.send_json({
                "type": "group_deleted",
                "group_id": group_id,
                "group_name": group.name
            })
        except:
            pass
    
    return success_response(message="Group deleted")

# ==================== WEBSOCKET ====================
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
                elif message_type == "friend_request":
                    # Обработка запроса в друзья через WebSocket
                    target_user_id = message_data.get("target_user_id")
                    if target_user_id:
                        friend = db.query(User).filter(User.id == target_user_id).first()
                        if friend:
                            existing = db.query(Friendship).filter(
                                ((Friendship.user_id == user_id) & (Friendship.friend_id == target_user_id)) |
                                ((Friendship.user_id == target_user_id) & (Friendship.friend_id == user_id))
                            ).first()
                            
                            if not existing:
                                friendship = Friendship(
                                    user_id=user_id,
                                    friend_id=target_user_id,
                                    status='pending'
                                )
                                db.add(friendship)
                                db.commit()
                                
                                if target_user_id in user_connections:
                                    await user_connections[target_user_id].send_json({
                                        "type": "friend_request",
                                        "from_user_id": user_id,
                                        "from_username": user.username if user else "Unknown"
                                    })
                elif message_type == "group_invite":
                    # Приглашение в группу через WebSocket
                    group_id = message_data.get("group_id")
                    user_login = message_data.get("user_login")
                    if group_id and user_login:
                        user = db.query(User).filter(User.username == user_login).first()
                        if user:
                            existing = db.query(GroupMember).filter(
                                GroupMember.group_id == group_id,
                                GroupMember.user_id == user.id
                            ).first()
                            
                            if not existing:
                                new_member = GroupMember(
                                    user_id=user.id,
                                    group_id=group_id,
                                    is_admin=False
                                )
                                db.add(new_member)
                                db.commit()
                                
                                group = db.query(Group).filter(Group.id == group_id).first()
                                if user.id in user_connections:
                                    await user_connections[user.id].send_json({
                                        "type": "group_invite",
                                        "group_id": group_id,
                                        "group_name": group.name,
                                        "inviter": user.username if user else "Unknown"
                                    })
                elif message_type == "remove_from_group":
                    # Удаление участника из группы
                    group_id = message_data.get("group_id")
                    target_user_id = message_data.get("user_id")
                    if group_id and target_user_id:
                        membership = db.query(GroupMember).filter(
                            GroupMember.group_id == group_id,
                            GroupMember.user_id == target_user_id
                        ).first()
                        if membership:
                            db.delete(membership)
                            db.commit()
                            
                            if target_user_id in user_connections:
                                await user_connections[target_user_id].send_json({
                                    "type": "removed_from_group",
                                    "group_id": group_id
                                })
                elif message_type == "leave_group":
                    # Выход из группы
                    group_id = message_data.get("group_id")
                    if group_id:
                        membership = db.query(GroupMember).filter(
                            GroupMember.group_id == group_id,
                            GroupMember.user_id == user_id
                        ).first()
                        if membership:
                            db.delete(membership)
                            db.commit()
                elif message_type == "delete_group":
                    # Удаление группы
                    group_id = message_data.get("group_id")
                    if group_id:
                        group = db.query(Group).filter(Group.id == group_id).first()
                        if group and group.creator_id == user_id:
                            db.query(GroupMember).filter(GroupMember.group_id == group_id).delete()
                            db.delete(group)
                            db.commit()
                            
                            # Уведомляем всех
                            for conn_id, ws in user_connections.items():
                                try:
                                    await ws.send_json({
                                        "type": "group_deleted",
                                        "group_id": group_id
                                    })
                                except:
                                    pass
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