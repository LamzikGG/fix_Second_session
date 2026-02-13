from sqlalchemy.orm import Session
from .models import Message, OfflineMessage
import json
from datetime import datetime

async def handle_message(message_data: dict, sender_id: int, db: Session, user_connections: dict):
    receiver_id = message_data["receiver_id"]
    content = message_data["content"]
    is_group = message_data.get("is_group", False)
    group_id = message_data.get("group_id")
    
    # Create message in database
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
    
    # Check if receiver is online
    if receiver_id in user_connections:
        # Send message directly
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
        # Store as offline message
        offline_msg = OfflineMessage(
            sender_id=sender_id,
            receiver_id=receiver_id,
            content=content
        )
        db.add(offline_msg)
        db.commit()
        
        # Mark original message as unread
        new_message.is_read = False
        db.commit()

async def deliver_offline_messages(user_id: int, websocket, db: Session):
    """Deliver pending offline messages when user comes online"""
    offline_messages = db.query(OfflineMessage).filter(
        OfflineMessage.receiver_id == user_id,
        OfflineMessage.delivered == False
    ).all()
    
    for msg in offline_messages:
        message_data = {
            "type": "message",
            "sender_id": msg.sender_id,
            "content": msg.content,
            "created_at": msg.created_at.isoformat(),
            "is_offline": True
        }
        await websocket.send_json(message_data)
        
        # Mark as delivered
        msg.delivered = True
        db.commit()