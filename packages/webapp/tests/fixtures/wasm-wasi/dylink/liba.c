/* liba: data, a function, and a constructor (5g fixture). */
#include <stdio.h>
int a_counter = 40;
static int a_ready;
__attribute__((constructor)) static void a_init(void) { a_ready = 1; }
int a_bump(int by) { return a_ready ? (a_counter += by) : -1; }
const char *a_name(void) { return "liba"; }
