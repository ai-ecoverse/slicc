package optel

// Checkpoint is the on-the-wire checkpoint name for a RUM event. Values
// mirror the helix-rum-js enumeration (and swift-optel's RUMCheckpoint); any
// string is accepted so a caller can forward a future/unknown checkpoint
// without a library update.
type Checkpoint string

// Supported checkpoints. go-optel callers are expected to use Enter and
// Error only (see the package doc comment) but the full helix-rum-js set is
// kept here so the type stays a drop-in match for the wire format shared
// with swift-optel and the webapp's telemetry.ts.
const (
	Top         Checkpoint = "top"
	Enter       Checkpoint = "enter"
	Navigate    Checkpoint = "navigate"
	Reload      Checkpoint = "reload"
	CWV         Checkpoint = "cwv"
	PagesViewed Checkpoint = "pagesviewed"
	Click       Checkpoint = "click"
	ViewBlock   Checkpoint = "viewblock"
	ViewMedia   Checkpoint = "viewmedia"
	FormSubmit  Checkpoint = "formsubmit"
	Error       Checkpoint = "error"
)
