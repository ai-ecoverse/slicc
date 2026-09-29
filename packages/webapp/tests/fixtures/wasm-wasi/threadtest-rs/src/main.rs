//! threadtest: a wasm32-wasip1-threads program for the wasm realm's threads
//! (#3530 phase 5d). See wasi-threads.test.ts.
use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::{Arc, Mutex};
use std::{env, fs, process, thread, time};

fn main() {
    let args: Vec<String> = env::args().collect();
    match args.get(1).map(String::as_str) {
        // Four threads sum, joined.
        Some("sum") => {
            let hs: Vec<_> = (0..4u64)
                .map(|i| thread::spawn(move || (0..100_000u64).map(|x| x * i).sum::<u64>()))
                .collect();
            let s: u64 = hs.into_iter().map(|h| h.join().unwrap()).sum();
            println!("sum {s}");
        }
        // One descriptor table: a file the main thread opened is written by a
        // thread; one a thread opened is read by the main thread.
        Some("files") => {
            let f = Arc::new(Mutex::new(fs::File::create("shared.txt").unwrap()));
            let g = Arc::clone(&f);
            thread::spawn(move || g.lock().unwrap().write_all(b"from a thread\n").unwrap())
                .join()
                .unwrap();
            f.lock().unwrap().write_all(b"from main\n").unwrap();
            drop(f);
            let mut opened = thread::spawn(|| fs::File::open("shared.txt").unwrap()).join().unwrap();
            let mut text = String::new();
            opened.seek(SeekFrom::Start(0)).unwrap();
            opened.read_to_string(&mut text).unwrap();
            print!("{text}");
        }
        // Threads write to stdout (fd 1) in turn.
        Some("stdout") => {
            let lock = Arc::new(Mutex::new(()));
            let hs: Vec<_> = (0..3)
                .map(|i| {
                    let lock = Arc::clone(&lock);
                    thread::spawn(move || {
                        let _g = lock.lock().unwrap();
                        println!("thread {i}");
                    })
                })
                .collect();
            for h in hs {
                h.join().unwrap();
            }
        }
        // exit() in a thread ends the process, the main thread still waiting.
        Some("exit") => {
            thread::spawn(|| process::exit(3));
            thread::sleep(time::Duration::from_secs(30));
            println!("not reached");
        }
        // Spawn until refused: the realm caps a process's threads.
        Some("cap") => {
            let n: usize = args[2].parse().unwrap();
            let hold = Arc::new(Mutex::new(()));
            let held = hold.lock().unwrap();
            let mut ok = 0;
            let mut hs = Vec::new();
            for _ in 0..n {
                let hold = Arc::clone(&hold);
                match thread::Builder::new().spawn(move || drop(hold.lock())) {
                    Ok(h) => {
                        ok += 1;
                        hs.push(h);
                    }
                    Err(_) => break,
                }
            }
            drop(held);
            for h in hs {
                h.join().unwrap();
            }
            println!("spawned {ok} of {n}");
            // Their workers are gone: spawning works again.
            println!("again {}", thread::spawn(|| 7).join().unwrap());
        }
        // Threads blocked (sleeping, reading stdin) until the process is signaled.
        Some("block") => {
            let sleeper = thread::spawn(|| thread::sleep(time::Duration::from_secs(60)));
            let reader = thread::spawn(|| {
                let mut buf = [0u8; 1];
                let _ = std::io::stdin().read(&mut buf);
            });
            println!("blocked");
            sleeper.join().unwrap();
            reader.join().unwrap();
        }
        // Sleeps in threads overlap.
        Some("sleep") => {
            let t0 = time::Instant::now();
            let hs: Vec<_> = (0..4)
                .map(|_| thread::spawn(|| thread::sleep(time::Duration::from_millis(200))))
                .collect();
            for h in hs {
                h.join().unwrap();
            }
            println!("overlapped {}", t0.elapsed() < time::Duration::from_millis(700));
        }
        _ => {
            eprintln!("usage: threadtest sum|files|stdout|exit|cap N|block|sleep");
            process::exit(2)
        }
    }
}
