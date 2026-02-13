from sqlalchemy.orm import Session
from .models import Call
import json
from datetime import datetime

async def handle_call_initiate(call_data: dict, initiator_id: int, db: Session, user_connections: dict):
    receiver_id = call_data["receiver_id"]
    call_type = call_data["call_type"]  # 'video' or 'audio'
    
    # Create call record
    new_call = Call(
        initiator_id=initiator_id,
        receiver_id=receiver_id,
        call_type=call_type,
        status='pending'
    )
    db.add(new_call)
    db.commit()
    db.refresh(new_call)
    
    # Notify receiver if online
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
        # Store as pending call
        new_call.status = 'offline'
        db.commit()

async def handle_call_response(response_data: dict, user_id: int, db: Session, user_connections: dict):
    call_id = response_data["call_id"]
    action = response_data["action"]  # 'accept' or 'decline'
    sdp = response_data.get("sdp")  # SDP answer if accepted
    
    call = db.query(Call).filter(Call.id == call_id).first()
    if not call:
        return
    
    if action == "decline":
        call.status = "declined"
        db.commit()
        
        # Notify initiator
        if call.initiator_id in user_connections:
            await user_connections[call.initiator_id].send_json({
                "type": "call_declined",
                "call_id": call_id
            })
    elif action == "accept":
        call.status = "accepted"
        call.ended_at = None
        db.commit()
        
        # Send SDP answer to initiator
        if call.initiator_id in user_connections:
            await user_connections[call.initiator_id].send_json({
                "type": "call_accepted",
                "call_id": call_id,
                "sdp": sdp
            })

async def handle_ice_candidate(candidate_data: dict, user_id: int, db: Session, user_connections: dict):
    call_id = candidate_data["call_id"]
    candidate = candidate_data["candidate"]
    target_user_id = candidate_data["target_user_id"]
    
    # Forward ICE candidate to target user
    if target_user_id in user_connections:
        await user_connections[target_user_id].send_json({
            "type": "ice_candidate",
            "call_id": call_id,
            "candidate": candidate,
            "sender_id": user_id
        })