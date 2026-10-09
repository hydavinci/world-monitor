use glib::variant::ToVariant;

fn main() {
    println!("glib-backport-regression-start");
    let value = ["zero", "one", "two", "three"].to_variant();
    assert_eq!(value.array_iter_str().unwrap().next(), Some("zero"));
    assert_eq!(value.array_iter_str().unwrap().nth(1), Some("one"));
    assert_eq!(value.array_iter_str().unwrap().last(), Some("three"));
    assert_eq!(value.array_iter_str().unwrap().next_back(), Some("three"));
    assert_eq!(value.array_iter_str().unwrap().nth_back(1), Some("two"));
    println!("glib-backport-regression-ok");
}
