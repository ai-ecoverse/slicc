package protocol

import (
	"encoding/json"
	"testing"
)

func TestUserMessageAckDecodes(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want UserMessageAck
	}{
		{
			name: "accepted",
			raw:  `{"type":"user_message_ack","messageId":"m1","scoopJid":"cone","state":"accepted"}`,
			want: UserMessageAck{Type: TypeUserMessageAck, MessageID: "m1", ScoopJid: "cone", State: AckAccepted},
		},
		{
			name: "rejected with error",
			raw:  `{"type":"user_message_ack","messageId":"m2","scoopJid":"cone","state":"rejected","error":"kernel busy"}`,
			want: UserMessageAck{Type: TypeUserMessageAck, MessageID: "m2", ScoopJid: "cone", State: AckRejected, Error: "kernel busy"},
		},
		{
			// A leader with no unit to deliver to rejects with an empty scoopJid.
			name: "rejected with no unit",
			raw:  `{"type":"user_message_ack","messageId":"m4","scoopJid":"","state":"rejected","error":"no agent"}`,
			want: UserMessageAck{Type: TypeUserMessageAck, MessageID: "m4", State: AckRejected, Error: "no agent"},
		},
		{
			// A future state still decodes; callers match only the states they know.
			name: "unknown state",
			raw:  `{"type":"user_message_ack","messageId":"m3","scoopJid":"cone","state":"queued"}`,
			want: UserMessageAck{Type: TypeUserMessageAck, MessageID: "m3", ScoopJid: "cone", State: "queued"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var got UserMessageAck
			if err := json.Unmarshal([]byte(tc.raw), &got); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if got != tc.want {
				t.Fatalf("decoded %#v, want %#v", got, tc.want)
			}
		})
	}
}

func TestUserMessageAckOmitsEmptyError(t *testing.T) {
	b, err := json.Marshal(UserMessageAck{Type: TypeUserMessageAck, MessageID: "m1", ScoopJid: "cone", State: AckAccepted})
	if err != nil {
		t.Fatal(err)
	}
	const want = `{"type":"user_message_ack","messageId":"m1","scoopJid":"cone","state":"accepted"}`
	if string(b) != want {
		t.Fatalf("encoded %s, want %s", b, want)
	}
}
