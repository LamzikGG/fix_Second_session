# webrtc.py
from sqlalchemy.orm import Session
from .models import Call
import json
from datetime import datetime

async def handle_call_initiate(call_data: dict, initiator_id: int, db: Session, user_connections: dict):
    receiver_id = call_data["receiver_id"]
    call_type = call_data.get("call_type", "audio")

    new_call = Call(
        initiator_id=initiator_id,
        receiver_id=receiver_id,
        call_type=call_type,
        status='pending'
    )
    db.add(new_call)
    db.commit()
    db.refresh(new_call)
    
    print(f"Call initiated: {new_call.id} from {initiator_id} to {receiver_id}")
    
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
        new_call.status = 'missed'
        db.commit()

async def handle_call_offer(offer_data: dict, user_id: int, db: Session, user_connections: dict):
    call_id = offer_data["call_id"]
    sdp = offer_data["sdp"]

    call = db.query(Call).filter(Call.id == call_id).first()
    if not call:
        print(f"⚠️ Call {call_id} not found for offer")
        return
    
    receiver_id = call.receiver_id

    if receiver_id in user_connections:
        print(f"📤 Forwarding OFFER to user {receiver_id}")
        await user_connections[receiver_id].send_json({
            "type": "call_offer",
            "call_id": call_id,
            "sdp": sdp,
            "initiator_id": user_id
        })
    else:
        print(f"Receiver {receiver_id} is offline, cannot send offer")

async def handle_call_response(response_data: dict, user_id: int, db: Session, user_connections: dict):
    call_id = response_data["call_id"]
    action = response_data["action"]  # 'accept' or 'decline'
    sdp = response_data.get("sdp")  # SDP answer если принято
    
    call = db.query(Call).filter(Call.id == call_id).first()
    if not call:
        print(f"Call {call_id} not found for response")
        return
    
    if action == "decline":
        call.status = "declined"
        db.commit()
        print(f"Call {call_id} declined")
        
        # Уведомляем инициатора
        if call.initiator_id in user_connections:
            await user_connections[call.initiator_id].send_json({
                "type": "call_declined",
                "call_id": call_id
            })
            
    elif action == "accept":
        call.status = "accepted"
        call.ended_at = None
        db.commit()
        print(f"Call {call_id} accepted")
        
        # Отправляем SDP Answer инициатору
        if call.initiator_id in user_connections:
            await user_connections[call.initiator_id].send_json({
                "type": "call_accepted",
                "call_id": call_id,
                "sdp": sdp
            })

async def handle_ice_candidate(candidate_data: dict, user_id: int, db: Session, user_connections: dict):
    """Пересылка ICE кандидатов"""
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
    else:
        print(f"Target user {target_user_id} not found for ICE candidate")

async def handle_call_end(call_data: dict, user_id: int, db: Session, user_connections: dict):
    call_id = call_data["call_id"]
    
    call = db.query(Call).filter(Call.id == call_id).first()
    if call:
        call.status = "completed"
        call.ended_at = datetime.utcnow()
        db.commit()
        
        other_user_id = call.receiver_id if call.initiator_id == user_id else call.initiator_id
        
        if other_user_id in user_connections:
            await user_connections[other_user_id].send_json({
                "type": "call_end",
                "call_id": call_id
            })