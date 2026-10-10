module github.com/ai-ecoverse/slicc-cli

go 1.26.5

require (
	github.com/ai-ecoverse/go-optel v0.0.0
	github.com/pion/ice/v4 v4.4.5
	github.com/pion/logging v0.2.4
	github.com/pion/webrtc/v4 v4.2.22
	golang.org/x/sys v0.47.0
)



replace github.com/ai-ecoverse/go-optel => ../go-optel

require (
	github.com/google/uuid v1.6.0 
	github.com/pion/datachannel v1.6.3 
	github.com/pion/dtls/v3 v3.1.9 
	github.com/pion/interceptor v0.1.49 
	github.com/pion/mdns/v2 v2.2.2 
	github.com/pion/randutil v0.1.0 
	github.com/pion/rtcp v1.2.18 
	github.com/pion/rtp v1.10.5 
	github.com/pion/sctp v1.11.3 
	github.com/pion/sdp/v3 v3.0.20 
	github.com/pion/srtp/v3 v3.1.0 
	github.com/pion/stun/v4 v4.0.1 
	github.com/pion/transport/v5 v5.1.1 
	github.com/pion/turn/v5 v5.1.2 
	github.com/wlynxg/anet v0.0.5 
	golang.org/x/crypto v0.52.0 
	golang.org/x/net v0.55.0 
	golang.org/x/time v0.14.0 
)
