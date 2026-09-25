package main

import "testing"

func TestPromptAckRejection(t *testing.T) {
	cases := []struct {
		name         string
		raw          string
		wantReason   string
		wantRejected bool
	}{
		{
			name: "accepted keeps waiting",
			raw:  `{"type":"user_message_ack","messageId":"mine","scoopJid":"cone","state":"accepted"}`,
		},
		{
			name:         "rejected carries the leader's error",
			raw:          `{"type":"user_message_ack","messageId":"mine","scoopJid":"cone","state":"rejected","error":"kernel busy"}`,
			wantReason:   "the leader rejected the prompt: kernel busy",
			wantRejected: true,
		},
		{
			name:         "rejected without an error still rejects",
			raw:          `{"type":"user_message_ack","messageId":"mine","scoopJid":"cone","state":"rejected"}`,
			wantReason:   "the leader rejected the prompt",
			wantRejected: true,
		},
		{
			name:         "rejected with no unit (empty scoopJid) still matches by messageId",
			raw:          `{"type":"user_message_ack","messageId":"mine","scoopJid":"","state":"rejected","error":"no agent"}`,
			wantReason:   "the leader rejected the prompt: no agent",
			wantRejected: true,
		},
		{
			name: "another message's rejection is ignored",
			raw:  `{"type":"user_message_ack","messageId":"theirs","scoopJid":"cone","state":"rejected","error":"x"}`,
		},
		{
			name: "unknown state is ignored",
			raw:  `{"type":"user_message_ack","messageId":"mine","scoopJid":"cone","state":"queued"}`,
		},
		{
			name: "undecodable frame is ignored",
			raw:  `{"type":"user_message_ack","messageId":`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reason, rejected := promptAckRejection([]byte(tc.raw), "mine")
			if rejected != tc.wantRejected || reason != tc.wantReason {
				t.Fatalf("promptAckRejection = (%q, %v), want (%q, %v)", reason, rejected, tc.wantReason, tc.wantRejected)
			}
		})
	}
}
