// A WASI command that imports functions from a namespace the runtime does not
// provide (acme_host.*) and prints what the calls returned.
#include <stdio.h>

__attribute__((import_module("acme_host"), import_name("probe"))) int acme_probe(void);
__attribute__((import_module("acme_host"), import_name("thread-spawn"))) int acme_spawn(void);
__attribute__((import_module("acme_host"), import_name("wide"))) long long acme_wide(void);
__attribute__((import_module("acme_host"), import_name("note"))) void acme_note(void);
// Two imports whose "namespace.name" would read the same: their types must not mix.
__attribute__((import_module("acme_host.x"), import_name("wide"))) long long acme_x_wide(void);
__attribute__((import_module("acme_host"), import_name("x.wide"))) int acme_dotted(void);

int main(void) {
  acme_note();
  printf("probe=%d spawn=%d wide=%lld x.wide=%lld,%d\n", acme_probe(), acme_spawn(), acme_wide(),
         acme_x_wide(), acme_dotted());
  return 0;
}
