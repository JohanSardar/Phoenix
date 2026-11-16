#!/bin/sh
# Installs Phoenix from GitHub Releases: curl -fsSL https://phoenix.eilmer.si/install | sh
# Pin a version with PHOENIX_VERSION=v0.1.0 or `sh -s -- v0.1.0`. Install elsewhere with PHOENIX_INSTALL=<dir>.
set -eu

repo="https://github.com/jujdontbudge/Phoenix"
install_dir="${PHOENIX_INSTALL:-$HOME/.phoenix}"
version="${1:-${PHOENIX_VERSION:-}}"

fail() { printf 'phoenix install: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required"; }

need curl
need tar
need uname
need mktemp

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "unsupported operating system $(uname -s); Phoenix runs on macOS and Linux" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "unsupported architecture $(uname -m); Phoenix runs on x64 and arm64" ;;
esac

if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi

if [ "$os" = linux ] && { [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ] || ldd --version 2>&1 | grep -qi musl; }; then
  fail "musl Linux (such as Alpine) is not supported; the bundled Node.js needs glibc"
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  fail "sha256sum or shasum is required to verify the download"
fi

if [ -z "$version" ]; then
  latest=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$repo/releases/latest") || fail "could not reach $repo/releases"
  version=${latest##*/}
  case "$version" in v*) ;; *) fail "no Phoenix release found at $repo/releases" ;; esac
fi
case "$version" in v*) ;; *) version="v$version" ;; esac

asset="phoenix-$os-$arch.tar.gz"
base="$repo/releases/download/$version"
mkdir -p "$install_dir"
tmp=$(mktemp -d "$install_dir/.install.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
trap 'exit 1' INT TERM

printf 'Downloading Phoenix %s for %s-%s\n' "$version" "$os" "$arch"
curl -fsSL -o "$tmp/$asset" "$base/$asset" || fail "could not download $base/$asset"
curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || fail "could not download $base/SHA256SUMS"

expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1 }' "$tmp/SHA256SUMS")
[ -n "$expected" ] || fail "SHA256SUMS has no entry for $asset"
actual=$(sha256 "$tmp/$asset")
[ "$actual" = "$expected" ] || fail "checksum mismatch for $asset (expected $expected, got $actual)"

mkdir "$tmp/unpacked"
tar -xzf "$tmp/$asset" -C "$tmp/unpacked"
[ -x "$tmp/unpacked/phoenix/node/bin/node" ] || fail "$asset does not contain a Phoenix build"

mkdir -p "$install_dir/versions" "$install_dir/bin"
target="$install_dir/versions/$version"
[ -d "$target" ] || mv "$tmp/unpacked/phoenix" "$target"

cat > "$tmp/phoenix" <<EOF
#!/bin/sh
exec "$target/node/bin/node" "$target/app/packages/cli/src/phoenix.ts" "\$@"
EOF
chmod 755 "$tmp/phoenix"
mv -f "$tmp/phoenix" "$install_dir/bin/phoenix"

"$install_dir/bin/phoenix" --help >/dev/null || fail "the installed phoenix does not start"
printf 'Installed Phoenix %s to %s/bin/phoenix\n' "$version" "$install_dir"

command -v git >/dev/null 2>&1 || printf 'Note: install git; capture snapshots read the working tree through it.\n'
command -v python3 >/dev/null 2>&1 || printf 'Note: install Python 3; capture uses it for terminal commands.\n'
command -v docker >/dev/null 2>&1 || command -v podman >/dev/null 2>&1 || printf 'Note: install Docker or Podman; replays run in a container.\n'

case ":$PATH:" in
  *":$install_dir/bin:"*) ;;
  *)
    # shellcheck disable=SC2016
    printf '\nAdd Phoenix to your PATH, for example in ~/.zshrc or ~/.bashrc:\n  export PATH="%s/bin:$PATH"\n' "$install_dir"
    ;;
esac
printf '\nRun this installer again to upgrade; older versions stay in %s/versions for captures still running on them. To uninstall, delete %s.\n' "$install_dir" "$install_dir"
