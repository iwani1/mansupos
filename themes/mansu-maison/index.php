<?php
/**
 * Fallback listing: blog, archives and non-product search.
 *
 * @package Mansu_Maison
 */

defined( 'ABSPATH' ) || exit;
get_header();
?>
<main id="main" class="wrap page-main">
	<header class="shop-head">
		<div class="rule" aria-hidden="true"></div>
		<h1 class="page-title">
		<?php
		if ( is_search() ) {
			/* translators: %s: search phrase */
			printf( esc_html__( 'Results for “%s”', 'mansu-maison' ), esc_html( get_search_query() ) );
		} elseif ( is_archive() ) {
			the_archive_title();
		} else {
			single_post_title();
		}
		?>
		</h1>
	</header>
	<?php if ( have_posts() ) : ?>
		<div class="post-list">
			<?php
			while ( have_posts() ) :
				the_post();
				?>
				<article <?php post_class( 'post-item' ); ?>>
					<?php if ( has_post_thumbnail() ) : ?><a href="<?php the_permalink(); ?>" tabindex="-1" aria-hidden="true"><?php the_post_thumbnail( 'medium_large' ); ?></a><?php endif; ?>
					<h2><a href="<?php the_permalink(); ?>"><?php the_title(); ?></a></h2>
					<p class="eyebrow"><time datetime="<?php echo esc_attr( get_the_date( 'c' ) ); ?>"><?php echo esc_html( get_the_date() ); ?></time></p>
					<?php the_excerpt(); ?>
				</article>
			<?php endwhile; ?>
		</div>
		<?php the_posts_pagination(); ?>
	<?php else : ?>
		<div class="empty"><h2><?php esc_html_e( 'Nothing found', 'mansu-maison' ); ?></h2><?php get_search_form(); ?></div>
	<?php endif; ?>
</main>
<?php
get_footer();
