/* librun: needs liba, found through its RUNTIME_PATH ($ORIGIN-relative), not beside it. */
int a_bump(int by);
int run_bump(int by) { return a_bump(by) + 1; }
