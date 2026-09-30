// A PIE main module with what a real one (CPython's) imports from `env`
// beyond memory and the bases (#3530, the dynamic linker): a weak undefined
// function (`&weak_missing` is null), a strong one that is only an error if
// called, and C++ thread_local objects with destructors (libc++abi asks for
// __cxa_thread_atexit_impl weakly, and falls back to its own).
#include <cstdio>
#include <cstring>
#include <thread>

extern "C" int weak_missing(int) __attribute__((weak));
extern "C" int strong_missing(void);

struct Guard {
  const char *name;
  explicit Guard(const char *n) : name(n) { std::printf("ctor %s\n", n); }
  ~Guard() { std::printf("dtor %s\n", name); }
};

thread_local Guard main_tl("main");

int main(int argc, char **argv) {
  std::printf("weak_missing is %s\n", weak_missing ? "present" : "absent");
  if (argc > 1 && std::strcmp(argv[1], "call-missing") == 0) return strong_missing();
  std::printf("main_tl is %s\n", main_tl.name);
  std::thread t([] {
    thread_local Guard thread_tl("thread");
    std::printf("thread_tl is %s\n", thread_tl.name);
  });
  t.join();
  std::printf("joined\n");
  std::fflush(stdout);
  return 0;
}
