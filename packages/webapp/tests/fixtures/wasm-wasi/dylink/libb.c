/* libb: needs liba (NEEDED), calls into it and into libc, keeps a pointer to its data. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
extern int a_counter;
int a_bump(int by);
const char *a_name(void);
int *b_counter_ptr = &a_counter;
int b_twice(int by) { a_bump(by); return a_bump(by); }
char *b_describe(void) {
  char *s = malloc(64);
  snprintf(s, 64, "%s counter %d", a_name(), *b_counter_ptr);
  return s;
}
typedef int (*op_t)(int);
op_t b_op(void) { return a_bump; }
