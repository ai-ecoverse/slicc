---
name: bluebubbles
description: Send and receive iMessages via BlueBubbles REST API
allowed-tools: bash
---

# BlueBubbles iMessage API

## First Time Setup

Before using this skill, you need the BlueBubbles server URL and password.

**Ask the user:**
1. "What is your BlueBubbles server URL?" (default: `http://localhost:1234`)
2. "What is your BlueBubbles password?"

**Store in memory** using `update_global_memory`:
```
bluebubbles_url: http://localhost:1234
bluebubbles_password: <user's password>
```

**Test the connection:**
```bash
curl -s "http://localhost:1234/api/v1/server/info?password=PASSWORD" | jq '.status'
```
If this returns `200`, the connection works.

## Authentication

All endpoints require `?password=PASSWORD` as a query parameter. Replace `PASSWORD` with the value from memory.

## IMPORTANT: Use POST /query endpoints

Most endpoints use POST with `/query` suffix. GET endpoints may return 404.

## Send a Message

**Use `--max-time 5` to prevent blocking** - the API waits for delivery confirmation which can take 30+ seconds.

```bash
curl -s --max-time 5 -X POST "SERVER_URL/api/v1/message/text?password=PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{
    "chatGuid": "iMessage;-;+1234567890",
    "message": "Hello from slicc!",
    "tempGuid": "temp-123456"
  }' || echo '{"note": "Request timed out - message may still be sending"}'
```

**Required Parameters:**
- `chatGuid`: Chat identifier (see Chat GUID Format below)
- `message`: Text content to send
- `tempGuid`: **Required** - A unique temporary ID. Use `temp-$(date +%s)`

**Important**: A timeout does NOT mean failure - verify delivery by querying recent messages.

## Chat GUID Format - IMPORTANT

There are THREE different GUID prefixes with different meanings:

| Prefix | Meaning | Use Case |
|--------|---------|----------|
| `iMessage;-;` | Direct message format | **Use this to SEND messages** to a phone/email |
| `any;-;` | Existing 1:1 chat | Returned by chat queries for existing conversations |
| `any;+;` | **Group chat** | Multiple participants - be careful! |

**To send a direct message to someone**: Always use `iMessage;-;address` format:
- Phone: `iMessage;-;+1234567890` (include country code)
- Email: `iMessage;-;user@example.com`

**Do NOT use `any;+;` GUIDs** - those are group chats with multiple participants!

## Find a Contact by Name

Chats don't store contact names - use the Contacts API:

```bash
curl -s "SERVER_URL/api/v1/contact?password=PASSWORD" \
  | jq '.data[] | select(.displayName != null) | select(.displayName | test("Name"; "i")) | {displayName, phoneNumbers, emails}'
```

## Find Existing Chats with a Contact

**Step 1**: Find chats containing a specific address:
```bash
curl -s -X POST "SERVER_URL/api/v1/chat/query?password=PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"limit": 200}' | jq '.data[] | select(.participants[] | .address == "user@example.com") | {guid, participantCount: (.participants | length), participants: [.participants[] | .address]}'
```

**Step 2**: Filter to ONLY direct chats (1 participant):
```bash
curl -s -X POST "SERVER_URL/api/v1/chat/query?password=PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"limit": 200}' | jq '.data[] | select(.participants | length == 1) | select(.participants[0].address == "user@example.com") | {guid, participant: .participants[0].address}'
```

**If no direct chat exists**: Create one by sending with `iMessage;-;address` format.

## Distinguish Direct vs Group Chats

Check the participant count before sending:
```bash
# This returns group chats (2+ participants) - DON'T send personal messages here!
curl -s -X POST "SERVER_URL/api/v1/chat/query?password=PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"limit": 200}' | jq '.data[] | select(.participants | length > 1) | {guid, participantCount: (.participants | length), participants: [.participants[] | .address]}'
```

## Get Recent Messages

```bash
curl -s -X POST "SERVER_URL/api/v1/message/query?password=PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"limit": 10}' | jq '.data[] | {text, isFromMe, dateCreated, from: .handle.address}'
```

## Get Messages from a Specific Chat

Use the `chatGuid` parameter in message query:
```bash
curl -s -X POST "SERVER_URL/api/v1/message/query?password=PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{
    "chatGuid": "any;-;user@example.com",
    "limit": 10
  }' | jq '.data[] | {text, isFromMe, dateCreated}'
```

## Verify Message Was Sent

After sending (even if timed out), check if message appears:
```bash
curl -s -X POST "SERVER_URL/api/v1/message/query?password=PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"limit": 5}' | jq '.data[] | select(.isFromMe == true) | {text, dateCreated}'
```

## Error Handling

- A 400 error means the message was NOT sent - check the error message
- A timeout does NOT mean failure - the message may still be sending
- Always verify by querying recent messages after sending
- If you get connection errors, ask the user to verify the BlueBubbles server URL and password
