package optel

type Checkpoint string

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
