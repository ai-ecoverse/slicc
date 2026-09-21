//go:build !darwin

package computer

import "context"








type Session struct{}


func Preflight(_ context.Context) (Grants, error) { return Grants{}, ErrUnsupported }


func Start(_ context.Context, _ Options) (*Session, error) { return nil, ErrUnsupported }


func (s *Session) Retarget(_ context.Context, _ string) error { return nil }


func (s *Session) Stop() {}
